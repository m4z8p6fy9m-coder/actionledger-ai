import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActionEngine } from "../src/engine.js";
import { ActionStore } from "../src/store.js";
import { SqliteDriver } from "../src/driver.js";
import { createGateway } from "../src/mcp.js";
import type { Connector } from "../src/contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});
const semantic = "a".repeat(64);
async function setup(execute: Connector["execute"]) {
  const driver = new SqliteDriver(":memory:");
  cleanup.push(() => driver.close());
  const store = new ActionStore(driver);
  await store.initialize();
  const connector: Connector = {
    id: "fixture",
    binding: "v1",
    key: (id) => "key_" + id,
    parse: (_op, input) => input,
    execute,
    reconcile: async () => ({ kind: "unknown", code: "NO_EVIDENCE" }),
  };
  const engine = new ActionEngine(store, [connector], {
    multiAgentWindowMs: 0,
  });
  for (const id of ["intent-A", "intent-B"]) {
    await engine.prepare({
      id,
      connector: "fixture",
      operation: "write",
      input: {},
    });
    await store.decide(id, "approve", "Operator", "Reviewed");
  }
  const server = createGateway(engine, ["intent-A", "intent-B"], {
    "intent-A": { agentId: "agent-A", semanticHash: semantic },
    "intent-B": { agentId: "agent-B", semanticHash: semantic },
  });
  const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { engine, store, client };
}
describe("host-bound multi-agent fencing", () => {
  it("blocks B while A is running and permits a later explicit invocation after success", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { client, store } = await setup(async () => {
      calls++;
      if (calls === 1) {
        entered();
        await gate;
      }
      return {
        kind: "succeeded",
        reference: "receipt-" + calls,
        result: { calls },
      };
    });
    const first = client.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: "intent-A" },
    });
    try {
      await started;
      const blocked = await client.callTool({
        name: "actionledger_invoke",
        arguments: { intentId: "intent-B" },
      });
      expect(blocked.structuredContent).toMatchObject({
        statusCode: 423,
        error: "AgentCollisionLock",
        status: "LOCKED",
      });
      expect(
        (
          await client.callTool({
            name: "actionledger_status",
            arguments: { intentId: "intent-B" },
          })
        ).structuredContent,
      ).toMatchObject({ status: "LOCKED" });
      expect(calls).toBe(1);
      release();
      expect((await first).structuredContent).toMatchObject({
        status: "SUCCEEDED",
      });
      expect((await store.get("intent-B")).attempts).toBe(0);
      expect(
        (
          await client.callTool({
            name: "actionledger_invoke",
            arguments: { intentId: "intent-B" },
          })
        ).structuredContent,
      ).toMatchObject({ status: "SUCCEEDED" });
      expect(calls).toBe(2);
    } finally {
      release();
      await first;
    }
  });
  it("keeps B frozen after an uncertain effect and expired window, including direct dispatch", async () => {
    let calls = 0;
    const { engine, client, store } = await setup(async () => {
      calls++;
      return { kind: "unknown", code: "NO_EVIDENCE" };
    });
    expect(
      (
        await client.callTool({
          name: "actionledger_invoke",
          arguments: { intentId: "intent-A" },
        })
      ).structuredContent,
    ).toMatchObject({ status: "UNKNOWN" });
    expect(
      (
        await client.callTool({
          name: "actionledger_invoke",
          arguments: { intentId: "intent-B" },
        })
      ).structuredContent,
    ).toMatchObject({ statusCode: 423, status: "LOCKED" });
    expect(await store.agentBlocked("intent-B")).toBe(true);
    expect((await engine.invoke("intent-B")).status).toBe("READY");
    expect(
      (
        await client.callTool({
          name: "actionledger_invoke",
          arguments: { intentId: "intent-B" },
        })
      ).isError,
    ).toBe(true);
    expect(calls).toBe(1);
  });
  it("does not block the winner when two agents contend for the same intent", async () => {
    let calls = 0;
    const { engine, store } = await setup(async () => {
      calls++;
      return { kind: "succeeded", reference: "receipt-one", result: {} };
    });
    expect(
      await engine.acquireMultiAgentLock("intent-A", semantic, "agent-A"),
    ).toBe(true);
    expect(
      await engine.acquireMultiAgentLock("intent-A", semantic, "agent-B"),
    ).toBe(false);
    expect(await store.agentBlocked("intent-A")).toBe(false);
    expect((await engine.invoke("intent-A")).status).toBe("SUCCEEDED");
    expect(calls).toBe(1);
  });
});
