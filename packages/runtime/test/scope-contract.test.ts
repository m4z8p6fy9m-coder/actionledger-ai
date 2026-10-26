import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadRuntime } from "../src/config.js";

async function fixture() {
  await mkdir("work", { recursive: true });
  const root = resolve("work", "scope-contract-" + randomUUID());
  await mkdir(root);
  const promptA = "a".repeat(64);
  const promptB = "b".repeat(64);
  const assetA = JSON.stringify(["tenant-a", "invoice-42"]);
  const assetB = JSON.stringify(["tenant-b", "invoice-42"]);
  const entries = [
    ["same-a", promptA, assetA],
    ["same-b", promptA, assetA],
    ["prompt-other", promptB, assetA],
    ["asset-other", promptA, JSON.stringify(["tenant-a", "invoice-43"])],
    ["tenant-other", promptA, assetB],
    ["unscoped-a", promptA, "invoice-42"],
    ["unscoped-b", promptA, "invoice-42"],
    ["recovery-a", promptA, "recovery-asset"],
    ["recovery-b", promptA, "recovery-asset"],
  ];
  const manifest = {
    namespace: "scope-test",
    intents: entries.map(([id]) => ({
      id,
      connector: "rest-test",
      operation: "write",
      input: id === "same-b" ? { amount: 999 } : {},
    })),
    rest: [
      {
        id: "rest-test",
        url: "http://127.0.0.1:9",
        operation: "write",
        inputSchema: { type: "object" },
      },
    ],
    multiAgent: {
      windowMs: 1000,
      bindings: entries.map(([intentId, promptHash, assetId], i) => ({
        intentId,
        agentId: "agent-" + i,
        promptHash,
        assetId,
      })),
    },
  };
  const path = resolve(root, "manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  const runtime = await loadRuntime({
    ACTIONLEDGER_MANIFEST: path,
    RUNTIME_DB: resolve(root, "ledger.sqlite"),
  });
  for (const [id] of entries)
    await runtime.engine.store.decide(id, "approve", "operator", "Fixture");
  return runtime;
}

describe("host collision-group contract", () => {
  it("groups equal prompt and asset, while differing prompt or asset remain independent", async () => {
    const runtime = await fixture();
    try {
      const bindings = runtime.multiAgentBindings!;
      expect(bindings["same-a"].semanticHash).toBe(
        bindings["same-b"].semanticHash,
      );
      expect(bindings["same-a"].semanticHash).not.toBe(
        bindings["prompt-other"].semanticHash,
      );
      expect(bindings["same-a"].semanticHash).not.toBe(
        bindings["asset-other"].semanticHash,
      );
      const acquire = async (id: string) =>
        runtime.engine.acquireMultiAgentLock(
          id,
          bindings[id].semanticHash,
          bindings[id].agentId,
        );
      expect(await acquire("same-a")).toBe(true);
      expect(await acquire("same-a")).toBe(true); // Same owner repeats the lock acquisition.
      expect(await acquire("same-b")).toBe(false);
      expect(await acquire("prompt-other")).toBe(true);
      expect(await acquire("asset-other")).toBe(true);
    } finally {
      await runtime.close();
    }
  });
  it("only separates tenants when the host qualifies the asset; equal unqualified IDs collide", async () => {
    const runtime = await fixture();
    try {
      const b = runtime.multiAgentBindings!;
      expect(b["same-a"].semanticHash).not.toBe(b["tenant-other"].semanticHash);
      expect(
        await runtime.engine.acquireMultiAgentLock(
          "same-a",
          b["same-a"].semanticHash,
          b["same-a"].agentId,
        ),
      ).toBe(true);
      expect(
        await runtime.engine.acquireMultiAgentLock(
          "tenant-other",
          b["tenant-other"].semanticHash,
          b["tenant-other"].agentId,
        ),
      ).toBe(true);
      expect(b["unscoped-a"].semanticHash).toBe(b["unscoped-b"].semanticHash);
      expect(
        await runtime.engine.acquireMultiAgentLock(
          "unscoped-a",
          b["unscoped-a"].semanticHash,
          b["unscoped-a"].agentId,
        ),
      ).toBe(true);
      expect(
        await runtime.engine.acquireMultiAgentLock(
          "unscoped-b",
          b["unscoped-b"].semanticHash,
          b["unscoped-b"].agentId,
        ),
      ).toBe(false);
    } finally {
      await runtime.close();
    }
  });
  it("fences a stale owner and holds UNKNOWN beyond both lease and minimum window", async () => {
    const runtime = await fixture();
    try {
      const store = runtime.engine.store;
      const b = runtime.multiAgentBindings!;
      const hash = b["recovery-a"].semanticHash;
      expect(
        await store.acquireMultiAgentLock(
          "recovery-a",
          hash,
          b["recovery-a"].agentId,
          1000,
          1000,
        ),
      ).toBe(true);
      const old = await store.claim("recovery-a", "execute", 1000, 1000);
      expect(old).not.toBeNull();
      const fresh = await store.claim("recovery-a", "reconcile", 1000, 2001);
      expect(fresh).not.toBeNull();
      if (!old || !fresh) throw new Error("Expected claims");
      await expect(
        store.finish(
          old,
          { kind: "succeeded", reference: "stale", result: {} },
          0,
          2002,
        ),
      ).rejects.toThrow("STALE_OWNER");
      await store.finish(
        fresh,
        { kind: "unknown", code: "NO_EVIDENCE" },
        0,
        2002,
      );
      expect(
        await store.acquireMultiAgentLock(
          "recovery-b",
          hash,
          b["recovery-b"].agentId,
          1000,
          100000,
        ),
      ).toBe(false);
      expect((await store.get("recovery-a")).status).toBe("UNKNOWN");
      const verified = await store.claim(
        "recovery-a",
        "reconcile",
        1000,
        100001,
      );
      if (!verified) throw new Error("Expected reconciliation claim");
      await store.finish(
        verified,
        {
          kind: "succeeded",
          reference: "verified",
          result: { verified: true },
        },
        0,
        100002,
      );
      expect(
        await store.acquireMultiAgentLock(
          "recovery-b",
          hash,
          b["recovery-b"].agentId,
          1000,
          100003,
        ),
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
