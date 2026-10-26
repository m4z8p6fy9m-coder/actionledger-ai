import {
  evidence,
  intentSchema,
  RuntimeError,
  type Connector,
  type ConnectorContext,
  type Evidence,
  type Intent,
  type RecordRow,
} from "./contracts.js";
import { ActionStore } from "./store.js";
export class ActionEngine {
  private connectors = new Map<string, Connector>();
  private active = new Set<Promise<unknown>>();
  private track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise.then(
      () => {
        this.active.delete(promise);
      },
      () => {
        this.active.delete(promise);
      },
    );
    return promise;
  }
  async drain(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active]);
  }
  readonly leaseMs: number;
  readonly timeoutMs: number;
  readonly multiAgentWindowMs: number;
  constructor(
    readonly store: ActionStore,
    connectors: readonly Connector[],
    options: {
      leaseMs?: number;
      timeoutMs?: number;
      multiAgentWindowMs?: number;
    } = {},
  ) {
    this.leaseMs = options.leaseMs ?? 30000;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.multiAgentWindowMs = options.multiAgentWindowMs ?? 1000;
    if (
      !Number.isSafeInteger(this.multiAgentWindowMs) ||
      this.multiAgentWindowMs < 0 ||
      this.multiAgentWindowMs > 86400000
    )
      throw new Error("Invalid multi-agent window");
    if (this.timeoutMs < 10 || this.leaseMs <= this.timeoutMs + 100)
      throw new Error(
        "Lease must exceed connector deadline plus checkpoint margin",
      );
    for (const connector of connectors) {
      if (this.connectors.has(connector.id))
        throw new Error("Duplicate connector ID");
      this.connectors.set(connector.id, connector);
    }
  }
  async acquireMultiAgentLock(
    intentId: string,
    semanticHash: string,
    agentId: string,
  ): Promise<boolean> {
    const acquired = await this.store.acquireMultiAgentLock(
      intentId,
      semanticHash,
      agentId,
      this.multiAgentWindowMs,
    );
    if (!acquired) {
      try {
        process.stderr.write(
          JSON.stringify({
            level: "critical",
            event: "CRITICAL_MULTI_AGENT_COLLISION_DETECTED_FENCING_ENGAGED",
            intentId,
            agentId,
          }) + "\n",
        );
      } catch {
        /* audit record persists independently */
      }
    }
    return acquired;
  }
  private connector(id: string): Connector {
    const connector = this.connectors.get(id);
    if (!connector) throw new RuntimeError("CONNECTOR_NOT_CONFIGURED");
    return connector;
  }
  async prepare(raw: Intent): Promise<RecordRow> {
    const intent = intentSchema.parse(raw);
    return this.store.register(intent, this.connector(intent.connector));
  }
  invoke(id: string): Promise<RecordRow> {
    return this.track(this.invokeOwned(id));
  }
  private async invokeOwned(id: string): Promise<RecordRow> {
    const row = await this.store.get(id);
    // Unknown effects are reconciled using reads, never automatically re-dispatched.
    if (row.status !== "READY") return row;
    const owned = await this.store.claim(id, "execute", this.leaseMs);
    if (!owned) return this.store.get(id);
    return this.run(owned, "execute");
  }
  reconcile(id: string, signal?: AbortSignal): Promise<RecordRow> {
    return this.track(this.reconcileOwned(id, signal));
  }
  private async reconcileOwned(
    id: string,
    signal?: AbortSignal,
  ): Promise<RecordRow> {
    const owned = await this.store.claim(id, "reconcile", this.leaseMs);
    if (!owned) return this.store.get(id);
    return this.run(owned, "reconcile", signal);
  }
  private async run(
    row: RecordRow,
    mode: "execute" | "reconcile",
    parent?: AbortSignal,
  ): Promise<RecordRow> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(parent ? [parent] : []),
    ]);
    let outcome: Evidence;
    try {
      const connector = this.connector(row.connector);
      if (
        connector.binding !== row.binding ||
        connector.key((await this.store.causalKey(row.id)) ?? row.id) !==
          row.provider_key
      )
        throw new RuntimeError("CONNECTOR_BINDING_CHANGED");
      const context: ConnectorContext = {
        intent: {
          id: row.id,
          connector: row.connector,
          operation: row.operation,
          input: JSON.parse(row.input),
        },
        key: row.provider_key,
        fingerprint: row.fingerprint,
        reference: row.reference,
        signal,
        bindReference: (reference) => this.store.bind(row, reference),
      };
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new RuntimeError("CONNECTOR_DEADLINE"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      try {
        outcome = evidence(
          await Promise.race([
            mode === "execute"
              ? connector.execute(context)
              : connector.reconcile(context),
            cancelled,
          ]),
        );
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } catch (error) {
      outcome = {
        kind: "unknown",
        code:
          error instanceof RuntimeError ? error.code : "CONNECTOR_UNCERTAIN",
      };
    }
    const delay = Math.min(300000, 1000 * 2 ** Math.min(row.checks, 8));
    try {
      const result = await this.store.finish(row, outcome, Date.now() + delay);
      if (result.status === "UNKNOWN" && outcome.kind === "unknown") {
        // MCP stdio reserves stdout for protocol messages. Never include payloads or credentials.
        try {
          process.stderr.write(
            JSON.stringify({
              level: "critical",
              event: "CRITICAL_UNKNOWN_RECONCILIATION_REQUIRED",
              intentId: row.id,
              connector: row.connector,
              code: outcome.code,
              message:
                "Review the Stripe or REST provider dashboard, or the relevant external provider, and reconcile the outcome manually. Do not force an automatic retry.",
            }) + "\n",
          );
        } catch {
          // An unavailable log sink must never alter an already persisted outcome.
        }
      }
      return result;
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "STALE_OWNER")
        return this.store.get(row.id);
      throw error;
    }
  }
}
export class RecoveryLoop {
  private task: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private lastError: string | null = null;
  constructor(
    private engine: ActionEngine,
    private intervalMs = 1000,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 20 || intervalMs > 300000)
      throw new Error("Invalid recovery interval");
  }
  get health() {
    return { running: this.task !== null, lastError: this.lastError };
  }
  async tick(signal?: AbortSignal): Promise<void> {
    for (const row of await this.engine.store.due()) {
      if (signal?.aborted) return;
      await this.engine.reconcile(row.id, signal);
    }
  }
  start(): void {
    if (this.task) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.task = (async () => {
      while (!signal.aborted) {
        try {
          await this.tick(signal);
          this.lastError = null;
        } catch {
          this.lastError = "RECONCILIATION_STORE_ERROR";
        }
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, this.intervalMs);
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    })();
  }
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.task;
    this.task = null;
    this.controller = null;
  }
}
