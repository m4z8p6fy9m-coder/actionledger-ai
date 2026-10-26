import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PostgresDriver } from "../src/driver.js";
import { ActionStore } from "../src/store.js";
import type { Connector } from "../src/contracts.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "PostgreSQL storage integration (requires a disposable database)",
  () => {
    it("migrates concurrently, fences independent connections and preserves final outcomes", async () => {
      const a = new PostgresDriver(url!),
        b = new PostgresDriver(url!);
      const one = new ActionStore(a),
        two = new ActionStore(b);
      const id = "pg-" + randomUUID();
      const otherId = "pg-" + randomUUID();
      const semanticHash = randomUUID().replaceAll("-", "").repeat(2);
      const connector: Connector = {
        id: "postgres-fixture",
        binding: "fixture",
        key: (id) => "pg." + id,
        parse: (_op, input) => input,
        execute: async () => ({ kind: "unknown", code: "FIXTURE" }),
        reconcile: async () => ({ kind: "unknown", code: "FIXTURE" }),
      };
      try {
        await Promise.all([one.initialize(), two.initialize()]);
        await Promise.all([
          one.register(
            {
              id,
              connector: connector.id,
              operation: "fixture",
              input: {},
              causal: { promptHash: "a".repeat(64), stateVector: { step: 1 } },
            },
            connector,
          ),
          two.register(
            {
              id,
              connector: connector.id,
              operation: "fixture",
              input: {},
              causal: { promptHash: "a".repeat(64), stateVector: { step: 1 } },
            },
            connector,
          ),
        ]);
        await one.decide(
          id,
          "approve",
          "CI operator",
          "Reviewed disposable fixture",
        );
        await two.register(
          {
            id: otherId,
            connector: connector.id,
            operation: "fixture",
            input: {},
          },
          connector,
        );
        await two.decide(otherId, "approve", "CI operator", "Reviewed fixture");
        const sameIntent = await Promise.all([
          one.acquireMultiAgentLock(id, semanticHash, "agent-A", 1000),
          two.acquireMultiAgentLock(id, semanticHash, "agent-B", 1000),
        ]);
        expect(sameIntent.filter(Boolean)).toHaveLength(1);
        expect(await one.agentBlocked(id)).toBe(false);
        await a.query(
          "DELETE FROM runtime_agent_locks WHERE semantic_hash=$1",
          [semanticHash],
        );
        const lockResults = await Promise.all([
          one.acquireMultiAgentLock(id, semanticHash, "agent-A", 1000),
          two.acquireMultiAgentLock(otherId, semanticHash, "agent-B", 1000),
        ]);
        expect(lockResults.filter(Boolean)).toHaveLength(1);
        expect(lockResults.filter((x) => !x)).toHaveLength(1);
        // Clear only this disposable lock fixture before the pre-existing claim checks.
        await a.query(
          "DELETE FROM runtime_agent_blocks WHERE semantic_hash=$1",
          [semanticHash],
        );
        await a.query(
          "DELETE FROM runtime_agent_locks WHERE semantic_hash=$1",
          [semanticHash],
        );
        const claims = await Promise.all([
          one.claim(id, "execute", 1000, 1000),
          two.claim(id, "execute", 1000, 1000),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const old = claims.find(Boolean)!;
        const fresh = await two.claim(id, "reconcile", 1000, 2001);
        expect(fresh?.fence).toBe(2);
        await expect(
          one.finish(
            old,
            { kind: "succeeded", reference: "pi_old", result: {} },
            0,
            2002,
          ),
        ).rejects.toThrow("STALE_OWNER");
        await two.finish(
          fresh!,
          { kind: "succeeded", reference: "pi_one", result: { ok: true } },
          0,
          2002,
        );
        expect((await one.get(id)).status).toBe("SUCCEEDED");
        expect(await two.claim(id, "execute", 1000, 2003)).toBeNull();
        expect(await one.causalKey(id)).toBe(await two.causalKey(id));
        expect(await one.causalKey(id)).toHaveLength(64);
        await two.freeze(id);
        expect(await one.frozen(id)).toBe(true);
        await expect(
          two.decide(id, "reject", "Other", "Override"),
        ).rejects.toThrow("DECISION_FINAL");
      } finally {
        await a.query(
          "DELETE FROM runtime_agent_blocks WHERE semantic_hash=$1",
          [semanticHash],
        );
        await a.query(
          "DELETE FROM runtime_agent_locks WHERE semantic_hash=$1",
          [semanticHash],
        );
        await a.query("DELETE FROM runtime_audit WHERE action_id=$1", [
          otherId,
        ]);
        await a.query("DELETE FROM runtime_actions WHERE id=$1", [otherId]);
        await a.query("DELETE FROM runtime_audit WHERE action_id=$1", [id]);
        await a.query("DELETE FROM runtime_freezes WHERE intent_id=$1", [id]);
        await a.query("DELETE FROM runtime_causal_map WHERE intent_id=$1", [
          id,
        ]);
        await a.query("DELETE FROM runtime_actions WHERE id=$1", [id]);
        await Promise.all([a.close(), b.close()]);
      }
    });
  },
);
