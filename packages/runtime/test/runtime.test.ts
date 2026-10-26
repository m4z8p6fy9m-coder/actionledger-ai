import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ActionEngine, RecoveryLoop } from "../src/engine.js";
import { ActionStore } from "../src/store.js";
import { SqliteDriver } from "../src/driver.js";
import { createGateway, McpToolConnector } from "../src/mcp.js";
import {
  causalFingerprint,
  signIntent,
  verifyIntent,
  type Connector,
  type Evidence,
  type Intent,
} from "../src/contracts.js";
import { RestConnector } from "../src/rest.js";
import { createServer } from "node:http";
const intent: Intent = {
  id: "invoice-001",
  connector: "fixture",
  operation: "write",
  input: { value: 10 },
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});
async function setup(options: { fail?: boolean; delay?: number } = {}) {
  const driver = new SqliteDriver(":memory:");
  cleanup.push(() => driver.close());
  const store = new ActionStore(driver);
  await store.initialize();
  let writes = 0;
  let reads = 0;
  const connector: Connector = {
    id: "fixture",
    binding: "fixture-v1",
    key: (id) => "fixture." + id,
    parse: (_operation, input) => input,
    execute: async () => {
      writes++;
      if (options.delay) await new Promise((r) => setTimeout(r, options.delay));
      if (options.fail) throw new Error("Response lost after external commit");
      return {
        kind: "succeeded",
        reference: "external-one",
        result: { writes },
      };
    },
    reconcile: async () => {
      reads++;
      return writes
        ? { kind: "succeeded", reference: "external-one", result: { writes } }
        : { kind: "unknown", code: "NOT_FINAL" };
    },
  };
  const engine = new ActionEngine(store, [connector]);
  await engine.prepare(intent);
  return { engine, store, connector, counts: () => ({ writes, reads }) };
}
async function sdk(engine: ActionEngine) {
  const server = createGateway(engine, [intent.id]);
  const client = new Client({ name: "test-host", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
describe("official MCP gateway", () => {
  it("registers intent and checks approval before every upstream invocation", async () => {
    const fixture = await setup();
    const client = await sdk(fixture.engine);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "actionledger_invoke",
      "actionledger_status",
    ]);
    const blocked = await client.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: intent.id },
    });
    expect(blocked.structuredContent).toMatchObject({
      status: "PENDING_APPROVAL",
    });
    expect(fixture.counts().writes).toBe(0);
    await fixture.store.decide(
      intent.id,
      "approve",
      "Operator",
      "Reviewed exact payload",
    );
    const result = await client.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: intent.id },
    });
    expect(result.structuredContent).toMatchObject({
      status: "SUCCEEDED",
      result: { writes: 1 },
    });
    await client.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: intent.id },
    });
    expect(fixture.counts().writes).toBe(1);
  });
  it("rejects ungranted IDs and model supplied input or approval overrides", async () => {
    const fixture = await setup();
    const client = await sdk(fixture.engine);
    expect(
      (
        await client.callTool({
          name: "actionledger_invoke",
          arguments: { intentId: "new-id" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "actionledger_invoke",
          arguments: {
            intentId: intent.id,
            input: { value: 999 },
            approve: true,
          },
        })
      ).isError,
    ).toBe(true);
    expect(fixture.counts().writes).toBe(0);
  });
  it("fences concurrent MCP calls before the external side effect", async () => {
    const fixture = await setup({ delay: 40 });
    await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
    const client = await sdk(fixture.engine);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        client.callTool({
          name: "actionledger_invoke",
          arguments: { intentId: intent.id },
        }),
      ),
    );
    expect(fixture.counts().writes).toBe(1);
    expect((await fixture.store.get(intent.id)).status).toBe("SUCCEEDED");
  });
  it("retains UNKNOWN on repeated agent calls, then repairs cached status using reads only", async () => {
    const fixture = await setup({ fail: true });
    await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
    const client = await sdk(fixture.engine);
    await client.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: intent.id },
    });
    await client.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: intent.id },
    });
    expect(fixture.counts().writes).toBe(1);
    await fixture.store.driver.query(
      "UPDATE runtime_actions SET next_check=0 WHERE id=$1",
      [intent.id],
    );
    await new RecoveryLoop(fixture.engine).tick();
    const status = await client.callTool({
      name: "actionledger_status",
      arguments: { intentId: intent.id },
    });
    expect(status.structuredContent).toMatchObject({ status: "SUCCEEDED" });
    expect(fixture.counts()).toEqual({ writes: 1, reads: 1 });
  });
  it("preserves immutable intent bindings and final human vetoes", async () => {
    const fixture = await setup();
    await expect(
      fixture.engine.prepare({ ...intent, input: { value: 11 } }),
    ).rejects.toThrow("INTENT_CONFLICT");
    await fixture.store.decide(
      intent.id,
      "reject",
      "Operator",
      "Do not dispatch",
    );
    await expect(
      fixture.store.decide(intent.id, "approve", "Other", "Override"),
    ).rejects.toThrow("DECISION_FINAL");
    await fixture.engine.invoke(intent.id);
    expect(fixture.counts().writes).toBe(0);
  });
  it("wraps an actual upstream MCP tool through the same ledger", async () => {
    let calls = 0;
    const upstream = new McpServer({ name: "fixture-tools", version: "1" });
    upstream.registerTool(
      "append",
      { inputSchema: z.object({ text: z.string() }).strict() },
      async ({ text }) => {
        calls++;
        return { content: [{ type: "text", text }] };
      },
    );
    const remote = new Client({ name: "gateway-host", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await upstream.connect(a);
    await remote.connect(b);
    cleanup.push(async () => {
      await remote.close();
      await upstream.close();
    });
    const fixture = await setup();
    const connector = new McpToolConnector("upstream", remote, "fixture", {
      append: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    });
    const engine = new ActionEngine(fixture.store, [connector]);
    const definition = {
      id: "append-001",
      connector: "upstream",
      operation: "append",
      input: { text: "one" },
    };
    await engine.prepare(definition);
    await engine.invoke(definition.id);
    expect(calls).toBe(0);
    await fixture.store.decide(
      definition.id,
      "approve",
      "Operator",
      "Reviewed",
    );
    expect((await engine.invoke(definition.id)).status).toBe("UNKNOWN");
    await engine.invoke(definition.id);
    expect(calls).toBe(1);
  });
});
describe("upstream finality and shutdown", () => {
  it("accepts a host-specified finality schema and refuses missing or invalid evidence", async () => {
    const upstream = new McpServer({
      name: "authoritative-fixture",
      version: "1",
    });
    upstream.registerTool(
      "submit",
      { inputSchema: z.object({ value: z.number() }).strict() },
      async ({ value }) => ({
        content: [{ type: "text" as const, text: "Result" }],
        structuredContent: {
          status: value === 1 ? "succeeded" : "pending",
          receipt: "fixture",
        },
      }),
    );
    const remote = new Client({ name: "host", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await upstream.connect(a);
    await remote.connect(b);
    cleanup.push(async () => {
      await remote.close();
      await upstream.close();
    });
    const fixture = await setup();
    const input = {
      submit: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
    };
    const finality = {
      submit: {
        type: "object",
        properties: {
          status: { const: "succeeded" },
          receipt: { type: "string" },
        },
        required: ["status", "receipt"],
      },
    };
    const connector = new McpToolConnector(
      "verified",
      remote,
      "fixture",
      input,
      finality,
    );
    const engine = new ActionEngine(fixture.store, [connector]);
    for (const value of [1, 2]) {
      const definition = {
        id: "verified-" + value,
        connector: "verified",
        operation: "submit",
        input: { value },
      };
      await engine.prepare(definition);
      await fixture.store.decide(
        definition.id,
        "approve",
        "Operator",
        "Reviewed",
      );
      expect((await engine.invoke(definition.id)).status).toBe(
        value === 1 ? "SUCCEEDED" : "UNKNOWN",
      );
    }
  });
  it("drains an in-flight external call before the store closes", async () => {
    const fixture = await setup({ delay: 50 });
    await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
    const call = fixture.engine.invoke(intent.id);
    await fixture.engine.drain();
    expect((await call).status).toBe("SUCCEEDED");
  });
});

describe("fenced autonomous reconciliation", () => {
  it("blocks late results after lease expiry and ownership transfer", async () => {
    const fixture = await setup();
    await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
    const old = await fixture.store.claim(intent.id, "execute", 50, 1000);
    expect(old).not.toBeNull();
    const fresh = await fixture.store.claim(intent.id, "reconcile", 500, 1051);
    expect(fresh?.fence).toBe(2);
    const result: Evidence = {
      kind: "succeeded",
      reference: "one",
      result: { ok: true },
    };
    await expect(fixture.store.finish(old!, result, 0, 1052)).rejects.toThrow(
      "STALE_OWNER",
    );
    await fixture.store.finish(fresh!, result, 0, 1052);
    expect((await fixture.store.get(intent.id)).status).toBe("SUCCEEDED");
  });
  it("does not accept a checkpoint after the current owner's lease expires", async () => {
    const fixture = await setup();
    await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
    const owner = await fixture.store.claim(intent.id, "execute", 20, 1000);
    await expect(
      fixture.store.finish(
        owner!,
        { kind: "succeeded", reference: "one", result: {} },
        0,
        1021,
      ),
    ).rejects.toThrow("STALE_OWNER");
  });
  it("bounds connector deadlines and leaves unresolved lookups UNKNOWN", async () => {
    const fixture = await setup();
    fixture.connector.execute = async () => new Promise<Evidence>(() => {});
    fixture.connector.reconcile = async () => ({
      kind: "unknown",
      code: "NO_AUTHORITATIVE_EVIDENCE",
    });
    const engine = new ActionEngine(fixture.store, [fixture.connector], {
      timeoutMs: 20,
      leaseMs: 200,
    });
    await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
    const row = await engine.invoke(intent.id);
    expect(row.status).toBe("UNKNOWN");
    await fixture.store.driver.query("UPDATE runtime_actions SET next_check=0");
    await new RecoveryLoop(engine).tick();
    expect((await fixture.store.get(intent.id)).status).toBe("UNKNOWN");
  });
  it("runs and stops background monitoring without overlapping dispatches", async () => {
    const fixture = await setup({ fail: true });
    await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
    await fixture.engine.invoke(intent.id);
    await fixture.store.driver.query("UPDATE runtime_actions SET next_check=0");
    const first = new RecoveryLoop(fixture.engine, 20);
    const second = new RecoveryLoop(fixture.engine, 20);
    first.start();
    second.start();
    await new Promise((r) => setTimeout(r, 80));
    await Promise.all([first.stop(), second.stop()]);
    expect((await fixture.store.get(intent.id)).status).toBe("SUCCEEDED");
    expect(fixture.counts()).toEqual({ writes: 1, reads: 1 });
  });
  it("refuses changed connector identities during recovery", async () => {
    const fixture = await setup({ fail: true });
    await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
    await fixture.engine.invoke(intent.id);
    await fixture.store.driver.query("UPDATE runtime_actions SET next_check=0");
    const changed = { ...fixture.connector, binding: "different-account" };
    await new ActionEngine(fixture.store, [changed]).reconcile(intent.id);
    expect((await fixture.store.get(intent.id)).error).toBe(
      "CONNECTOR_BINDING_CHANGED",
    );
    expect(fixture.counts().reads).toBe(0);
  });
});

describe("ledger binding invariants", () => {
  it("rejects connector mismatch and conflicting provider reference", async () => {
    const { store, connector } = await setup();
    await expect(
      store.register(
        { ...intent, id: "another", connector: "different" },
        connector,
      ),
    ).rejects.toThrow("CONNECTOR_MISMATCH");
    await store.decide(intent.id, "approve", "Operator", "Reviewed");
    const row = await store.claim(intent.id, "execute", 30000);
    expect(row).not.toBeNull();
    if (!row) throw new Error("Expected claim");
    await store.bind(row, "provider-original");
    await expect(
      store.finish(
        row,
        { kind: "succeeded", reference: "provider-other", result: {} },
        0,
      ),
    ).rejects.toThrow("STALE_OWNER");
    expect((await store.get(intent.id)).reference).toBe("provider-original");
    expect((await store.get(intent.id)).status).toBe("RUNNING");
  });
});

describe("causal identity and mutation fencing", () => {
  it("keeps fingerprints deterministic and verifies the complete signed intent", () => {
    const a: Intent = {
      ...intent,
      causal: { promptHash: "a".repeat(64), stateVector: { b: 2, a: 1 } },
    };
    const b: Intent = {
      ...intent,
      causal: { promptHash: "a".repeat(64), stateVector: { a: 1, b: 2 } },
    };
    expect(causalFingerprint(a)).toBe(causalFingerprint(b));
    expect(causalFingerprint(a)).not.toBe(
      causalFingerprint({
        ...b,
        causal: { ...b.causal!, promptHash: "b".repeat(64) },
      }),
    );
    const secret = "k".repeat(32);
    const signed = { ...a, signature: signIntent(a, secret) };
    expect(verifyIntent(signed, secret)).toBe(true);
    expect(verifyIntent({ ...signed, input: { value: 99 } }, secret)).toBe(
      false,
    );
  });
  it("persists one causal mapping and fences a mutated MCP request", async () => {
    const { store, connector, engine, counts } = await setup();
    const c: Intent = {
      ...intent,
      id: "causal-1",
      causal: { promptHash: "a".repeat(64), stateVector: [1, 2] },
    };
    const row = await store.register(c, connector);
    expect(row.provider_key).toBe(connector.key(causalFingerprint(c)));
    expect(await store.causalKey(c.id)).toBe(causalFingerprint(c));
    await expect(
      store.register(
        { ...c, causal: { ...c.causal!, stateVector: [2, 1] } },
        connector,
      ),
    ).rejects.toThrow("INTENT_CONFLICT");
    const client = await sdk(engine);
    await store.decide(intent.id, "approve", "Operator", "Reviewed");
    const blocked = await client.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: intent.id, input: { value: 999 } },
    });
    expect(blocked.structuredContent).toMatchObject({
      statusCode: 403,
      error: "MutatedPayload",
    });
    expect(await store.frozen(intent.id)).toBe(true);
    const retry = await client.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: intent.id },
    });
    expect(retry.isError).toBe(true);
    expect((await engine.invoke(intent.id)).status).toBe("READY");
    expect(counts().writes).toBe(0);
  });
  it("sends the mapped provider key to REST and treats unverified success as uncertain", async () => {
    let received = "";
    const server = createServer((req, res) => {
      received = String(req.headers["idempotency-key"]);
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const connector = new RestConnector(
      "rest",
      "http://127.0.0.1:" + address.port,
      undefined,
      "test",
      "write",
      { type: "object" },
    );
    const driver = new SqliteDriver(":memory:");
    cleanup.push(() => driver.close());
    const store = new ActionStore(driver);
    await store.initialize();
    const engine = new ActionEngine(store, [connector]);
    const restIntent: Intent = {
      ...intent,
      connector: "rest",
      causal: { promptHash: "a".repeat(64), stateVector: { step: 1 } },
    };
    const row = await engine.prepare(restIntent);
    await store.decide(restIntent.id, "approve", "Operator", "Reviewed");
    expect((await engine.invoke(restIntent.id)).status).toBe("UNKNOWN");
    expect(received).toBe(row.provider_key);
    expect(await store.causalKey(restIntent.id)).toBe(
      causalFingerprint(restIntent),
    );
  });
});

describe("uncertain outcome operator logging", () => {
  it("logs persisted unknown outcomes to stderr without disclosing payloads and never retries", async () => {
    const fixture = await setup({ fail: true });
    const log = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await fixture.store.decide(intent.id, "approve", "Operator", "Reviewed");
      const result = await fixture.engine.invoke(intent.id);
      expect(result.status).toBe("UNKNOWN");
      const entry = JSON.parse(String(log.mock.calls[0][0]));
      expect(entry).toMatchObject({
        level: "critical",
        event: "CRITICAL_UNKNOWN_RECONCILIATION_REQUIRED",
        intentId: intent.id,
        connector: "fixture",
      });
      expect(entry.message).toContain("dashboard");
      expect(entry.message).toContain("Do not force an automatic retry");
      expect(JSON.stringify(entry)).not.toContain('"value"');
      await fixture.engine.invoke(intent.id);
      expect(fixture.counts().writes).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
      await fixture.store.driver.query(
        "UPDATE runtime_actions SET next_check=0 WHERE id=$1",
        [intent.id],
      );
      const recovery = new ActionEngine(fixture.store, [
        {
          ...fixture.connector,
          reconcile: async () => ({
            kind: "unknown",
            code: "NO_PROVIDER_EVIDENCE",
          }),
        },
      ]);
      expect((await recovery.reconcile(intent.id)).status).toBe("UNKNOWN");
      expect(JSON.parse(String(log.mock.calls[1][0]))).toMatchObject({
        event: "CRITICAL_UNKNOWN_RECONCILIATION_REQUIRED",
        code: "NO_PROVIDER_EVIDENCE",
      });
      expect(fixture.counts().writes).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
});
