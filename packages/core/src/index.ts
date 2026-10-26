import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
export { z };
import {
  ActionQuery,
  actionFilterSql,
  actionsToCsv,
  MAX_EXPORT_ACTIONS,
  type ActionPage,
} from "./query.js";
export {
  ActionQuery,
  ActionStatus,
  actionsToCsv,
  MAX_EXPORT_ACTIONS,
  type ActionPage,
} from "./query.js";

export const PaymentInput = z
  .object({
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[a-zA-Z0-9_.:-]+$/),
    recipient: z.string().trim().min(1).max(100),
    amountCents: z.number().int().min(1).max(100000000),
    currency: z.literal("EUR").default("EUR"),
    providerMode: z.enum(["idempotent", "unprotected"]).default("idempotent"),
    description: z.string().trim().max(240).default("Agent payment"),
  })
  .strict();
export type Payment = z.infer<typeof PaymentInput>;
export type Status =
  | "PENDING_APPROVAL"
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "REJECTED"
  | "UNKNOWN";
export type Action = {
  id: string;
  idempotency_key: string;
  payload: string;
  fingerprint: string;
  status: Status;
  risk: "HIGH";
  attempts: number;
  owner: string | null;
  lease_until: number | null;
  receipt: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
export type Receipt = {
  id: string;
  recipient: string;
  amountCents: number;
  currency: "EUR";
  createdAt: string;
};
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 409,
  ) {
    super(message);
  }
}
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function tokenEqual(actual: string | undefined, expected: string) {
  const a = Buffer.from(actual ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
export const LEASE_MS = 30000;
export const MAX_ATTEMPTS = 5;
export class Ledger extends Store {
  constructor(file: string) {
    super(file);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL','READY','RUNNING','SUCCEEDED','REJECTED','UNKNOWN')), risk TEXT NOT NULL DEFAULT 'HIGH', attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER, receipt TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS approvals (action_id TEXT PRIMARY KEY REFERENCES actions(id), decision TEXT NOT NULL CHECK(decision IN ('approve','reject')), actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), number INTEGER NOT NULL, owner TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT NOT NULL, UNIQUE(action_id,number));" +
        "CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT REFERENCES actions(id), event TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS actions_created ON actions(created_at DESC); CREATE INDEX IF NOT EXISTS audit_action ON audit(action_id,seq); PRAGMA user_version=1;",
    );
  }
  audit(id: string | null, event: string, detail: unknown = {}) {
    this.db
      .prepare(
        "INSERT INTO audit(action_id,event,detail,created_at) VALUES(?,?,?,?)",
      )
      .run(id, event, JSON.stringify(detail), new Date().toISOString());
  }
  get(id: string): Action {
    const row = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id) as
      Action | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Action not found", 404);
    return row;
  }
  create(raw: unknown): { action: Action; duplicate: boolean } {
    const input = PaymentInput.parse(raw);
    const fingerprint = hash(input);
    return this.tx(() => {
      const old = this.db
        .prepare("SELECT * FROM actions WHERE idempotency_key=?")
        .get(input.idempotencyKey) as Action | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new DomainError(
            "KEY_CONFLICT",
            "Idempotency key is already bound to a different payload",
          );
        this.audit(old.id, "DUPLICATE_BLOCKED");
        return { action: old, duplicate: true };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO actions(id,idempotency_key,payload,fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.idempotencyKey,
          JSON.stringify(input),
          fingerprint,
          "PENDING_APPROVAL",
          now,
          now,
        );
      this.audit(id, "ACTION_CREATED", {
        risk: "HIGH",
        providerMode: input.providerMode,
      });
      return { action: this.get(id), duplicate: false };
    });
  }
  decide(
    id: string,
    decision: "approve" | "reject",
    actor: string,
    reason: string,
  ) {
    return this.tx(() => {
      const action = this.get(id);
      const old = this.db
        .prepare("SELECT decision FROM approvals WHERE action_id=?")
        .get(id);
      if (old) {
        if (old.decision === decision) return action;
        throw new DomainError(
          "DECISION_FINAL",
          "A recorded approval decision cannot be changed",
        );
      }
      if (action.status !== "PENDING_APPROVAL")
        throw new DomainError(
          "INVALID_STATE",
          "Action is not awaiting approval",
        );
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO approvals VALUES(?,?,?,?,?)")
        .run(id, decision, actor, reason, now);
      this.db
        .prepare("UPDATE actions SET status=?,updated_at=? WHERE id=?")
        .run(decision === "approve" ? "READY" : "REJECTED", now, id);
      this.audit(id, decision === "approve" ? "APPROVED" : "REJECTED", {
        actor,
        reason,
      });
      return this.get(id);
    });
  }
  markUncertain(id: string, owner: string, reason: string) {
    return this.tx(() => {
      const now = new Date().toISOString();
      const changed = this.db
        .prepare(
          "UPDATE actions SET status='UNKNOWN',owner=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=? AND owner=? AND status='RUNNING'",
        )
        .run(reason, now, id, owner);
      if (changed.changes) {
        this.db
          .prepare(
            "UPDATE attempts SET outcome='UNKNOWN',finished_at=? WHERE owner=?",
          )
          .run(now, owner);
        this.audit(id, "OUTCOME_UNKNOWN", { reason });
      }
      return this.get(id);
    });
  }
  expire(id: string, now = Date.now()) {
    const a = this.get(id);
    if (a.status === "RUNNING" && (a.lease_until ?? Infinity) <= now && a.owner)
      return this.markUncertain(
        id,
        a.owner,
        "Execution lease expired; external outcome is uncertain",
      );
    return a;
  }
  claim(id: string, owner: string, recovery = false, now = Date.now()): Action {
    return this.tx(() => {
      const a = this.get(id);
      const input = PaymentInput.parse(JSON.parse(a.payload));
      if (a.status === "SUCCEEDED") return a;
      if (a.status === "RUNNING")
        throw new DomainError(
          "IN_PROGRESS",
          "Another worker holds the execution lease",
        );
      if (
        a.status === "UNKNOWN" &&
        (!recovery || input.providerMode !== "idempotent")
      )
        throw new DomainError(
          "UNSAFE_RETRY",
          "Outcome unknown. Automatic replay is blocked without provider-enforced idempotency.",
        );
      if (a.status !== "READY" && !(a.status === "UNKNOWN" && recovery))
        throw new DomainError(
          "APPROVAL_REQUIRED",
          "A durable human approval is required before execution",
        );
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM approvals WHERE action_id=? AND decision='approve'",
          )
          .get(id)
      )
        throw new DomainError("APPROVAL_REQUIRED", "Approval missing");
      if (a.attempts >= MAX_ATTEMPTS)
        throw new DomainError(
          "ATTEMPTS_EXHAUSTED",
          "Retry limit reached; investigate and reconcile externally",
        );
      const timestamp = new Date(now).toISOString();
      this.db
        .prepare(
          "UPDATE actions SET status='RUNNING',attempts=attempts+1,owner=?,lease_until=?,error=NULL,updated_at=? WHERE id=?",
        )
        .run(owner, now + LEASE_MS, timestamp, id);
      this.db
        .prepare(
          "INSERT INTO attempts(id,action_id,number,owner,started_at,outcome) VALUES(?,?,?,?,?,?)",
        )
        .run(randomUUID(), id, a.attempts + 1, owner, timestamp, "RUNNING");
      this.audit(id, recovery ? "RECOVERY_DISPATCHED" : "EXECUTION_STARTED", {
        attempt: a.attempts + 1,
        owner,
      });
      return this.get(id);
    });
  }
  async execute(
    id: string,
    charge: (payment: Payment) => Promise<Receipt>,
    options: {
      owner?: string;
      recovery?: boolean;
      afterCommit?: () => void;
    } = {},
  ) {
    const owner = options.owner ?? randomUUID();
    const action = this.claim(id, owner, options.recovery);
    if (action.status === "SUCCEEDED") return action;
    const payment = PaymentInput.parse(JSON.parse(action.payload));
    try {
      const receipt = validateReceipt(await charge(payment), payment);
      options.afterCommit?.();
      return this.tx(() => {
        const now = new Date().toISOString();
        const updated = this.db
          .prepare(
            "UPDATE actions SET status='SUCCEEDED',receipt=?,owner=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE id=? AND owner=? AND status='RUNNING'",
          )
          .run(JSON.stringify(receipt), now, id, owner);
        if (!updated.changes)
          throw new DomainError(
            "STALE_WORKER",
            "Worker lost ownership; its result cannot overwrite recovery state",
          );
        this.db
          .prepare(
            "UPDATE attempts SET outcome='SUCCEEDED',finished_at=? WHERE owner=?",
          )
          .run(now, owner);
        this.audit(id, "EXECUTION_SUCCEEDED", { receiptId: receipt.id });
        return this.get(id);
      });
    } catch (e) {
      this.markUncertain(
        id,
        owner,
        e instanceof Error ? e.message : "Unknown provider error",
      );
      throw e;
    }
  }
  detail(id: string) {
    return {
      action: this.get(id),
      approval:
        this.db.prepare("SELECT * FROM approvals WHERE action_id=?").get(id) ??
        null,
      attempts: this.db
        .prepare("SELECT * FROM attempts WHERE action_id=? ORDER BY number")
        .all(id),
      audit: this.db
        .prepare("SELECT * FROM audit WHERE action_id=? ORDER BY seq")
        .all(id),
    };
  }
  listPage(raw: unknown): ActionPage {
    const query = ActionQuery.parse(raw);
    const { where, params } = actionFilterSql(query);
    const order = query.sort === "oldest" ? "ASC" : "DESC";
    return this.tx(() => {
      const total = Number(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM actions " + where)
          .get(...params)!.count,
      );
      const items = this.db
        .prepare(
          "SELECT * FROM actions " +
            where +
            " ORDER BY created_at " +
            order +
            ",id " +
            order +
            " LIMIT ? OFFSET ?",
        )
        .all(...params, query.limit, query.offset) as Action[];
      return {
        items,
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + items.length < total,
      };
    });
  }
  exportActions(raw: unknown): string {
    const query = ActionQuery.pick({ q: true, status: true, sort: true }).parse(
      raw,
    );
    const { where, params } = actionFilterSql(query);
    return this.tx(() => {
      const total = Number(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM actions " + where)
          .get(...params)!.count,
      );
      if (total > MAX_EXPORT_ACTIONS)
        throw new DomainError(
          "EXPORT_TOO_LARGE",
          "Export is limited to 10,000 matching actions. Narrow the search or status filter.",
          422,
        );
      const order = query.sort === "oldest" ? "ASC" : "DESC";
      const items = this.db
        .prepare(
          "SELECT * FROM actions " +
            where +
            " ORDER BY created_at " +
            order +
            ",id " +
            order +
            " LIMIT ?",
        )
        .all(...params, MAX_EXPORT_ACTIONS) as Action[];
      return actionsToCsv(items);
    });
  }
  snapshot() {
    const counts = this.db
      .prepare("SELECT status,COUNT(*) AS count FROM actions GROUP BY status")
      .all();
    const duplicates = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM audit WHERE event='DUPLICATE_BLOCKED'",
        )
        .get()!.count,
    );
    return {
      actions: this.db
        .prepare(
          "SELECT * FROM actions ORDER BY created_at DESC,id DESC LIMIT 200",
        )
        .all() as Action[],
      counts,
      duplicates,
      audit: this.db
        .prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT 200")
        .all(),
      approvals: this.db
        .prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200")
        .all(),
      attempts: this.db.prepare("SELECT COUNT(*) AS count FROM attempts").get()!
        .count,
    };
  }
}
export class PaymentProvider extends Store {
  constructor(file: string) {
    super(file);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, logical_key TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests(seq INTEGER PRIMARY KEY AUTOINCREMENT, logical_key TEXT NOT NULL, deduplicated INTEGER NOT NULL, created_at TEXT NOT NULL); PRAGMA user_version=1;",
    );
  }
  charge(raw: unknown): Receipt {
    const input = PaymentInput.parse(raw);
    const fingerprint = hash(input);
    return this.tx(() => {
      const existing =
        input.providerMode === "idempotent"
          ? this.db
              .prepare("SELECT * FROM payments WHERE idempotency_key=?")
              .get(input.idempotencyKey)
          : undefined;
      if (existing && existing.fingerprint !== fingerprint)
        throw new DomainError(
          "PROVIDER_KEY_CONFLICT",
          "Provider key is bound to another payload",
        );
      this.db
        .prepare(
          "INSERT INTO requests(logical_key,deduplicated,created_at) VALUES(?,?,?)",
        )
        .run(input.idempotencyKey, existing ? 1 : 0, new Date().toISOString());
      if (existing) return JSON.parse(String(existing.receipt)) as Receipt;
      const receipt: Receipt = {
        id: "pay_" + randomUUID(),
        recipient: input.recipient,
        amountCents: input.amountCents,
        currency: input.currency,
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare("INSERT INTO payments VALUES(?,?,?,?,?)")
        .run(
          receipt.id,
          input.providerMode === "idempotent" ? input.idempotencyKey : null,
          input.idempotencyKey,
          fingerprint,
          JSON.stringify(receipt),
        );
      return receipt;
    });
  }
  snapshot() {
    return {
      payments: this.db
        .prepare(
          "SELECT receipt,logical_key,idempotency_key FROM payments ORDER BY rowid DESC LIMIT 200",
        )
        .all()
        .map((r) => ({
          ...(JSON.parse(String(r.receipt)) as Receipt),
          logicalKey: r.logical_key,
          protected: r.idempotency_key !== null,
        })),
      paymentCount: Number(
        this.db.prepare("SELECT COUNT(*) AS n FROM payments").get()!.n,
      ),
      totalCents: Number(
        this.db
          .prepare(
            "SELECT COALESCE(SUM(json_extract(receipt,'$.amountCents')),0) AS n FROM payments",
          )
          .get()!.n,
      ),
      requestCount: Number(
        this.db.prepare("SELECT COUNT(*) AS n FROM requests").get()!.n,
      ),
      deduplicated: Number(
        this.db
          .prepare("SELECT COALESCE(SUM(deduplicated),0) AS n FROM requests")
          .get()!.n,
      ),
    };
  }
}

export async function chargeHttp(
  url: string,
  token: string,
  payment: Payment,
): Promise<Receipt> {
  const response = await fetch(url + "/payments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify(payment),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      "Provider returned HTTP " +
        response.status +
        "; outcome requires reconciliation",
    );
  return validateReceipt(await response.json(), payment);
}

/** Bind every adapter result to the approved intent, including non-HTTP adapters. */
export function validateReceipt(raw: unknown, payment: Payment): Receipt {
  const receipt = z
    .object({
      id: z.string().min(1).max(200),
      recipient: z.string(),
      amountCents: z.number().int().positive(),
      currency: z.literal("EUR"),
      createdAt: z.string().datetime(),
    })
    .strict()
    .parse(raw);
  if (
    receipt.amountCents !== payment.amountCents ||
    receipt.recipient !== payment.recipient ||
    receipt.currency !== payment.currency
  )
    throw new Error(
      "Provider receipt does not match the approved payment; outcome is uncertain",
    );
  return receipt;
}

export * from "./evidence.js";
