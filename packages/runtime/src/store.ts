import { randomUUID } from "node:crypto";
import {
  canonical,
  causalFingerprint,
  digest,
  intentSchema,
  RuntimeError,
  type Connector,
  type Evidence,
  type Intent,
  type RecordRow,
} from "./contracts.js";
import type { Driver } from "./driver.js";
export class ActionStore {
  constructor(readonly driver: Driver) {}
  async initialize(): Promise<void> {
    // Additive, independently versioned runtime tables; existing dashboard stores are untouched.
    await this.driver.transaction(async (db) => {
      if (db.dialect === "postgres")
        await db.query("SELECT pg_advisory_xact_lock(5409006)");
      await db.query(
        "CREATE TABLE IF NOT EXISTS runtime_actions(id TEXT PRIMARY KEY, connector TEXT NOT NULL, operation TEXT NOT NULL, input TEXT NOT NULL, fingerprint TEXT NOT NULL, provider_key TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL','READY','RUNNING','UNKNOWN','SUCCEEDED','REJECTED')), approval TEXT, actor TEXT, reason TEXT, owner TEXT, fence INTEGER NOT NULL DEFAULT 0, lease_until DOUBLE PRECISION NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, reference TEXT, result TEXT, error TEXT, next_check DOUBLE PRECISION NOT NULL DEFAULT 0, checks INTEGER NOT NULL DEFAULT 0, created_at DOUBLE PRECISION NOT NULL, updated_at DOUBLE PRECISION NOT NULL)",
      );
      await db.query(
        "CREATE INDEX IF NOT EXISTS runtime_due ON runtime_actions(status,next_check,lease_until)",
      );
      await db.query(
        "CREATE TABLE IF NOT EXISTS runtime_audit(id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES runtime_actions(id), event TEXT NOT NULL, detail TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL)",
      );
      await db.query(
        "CREATE TABLE IF NOT EXISTS runtime_causal_map(intent_id TEXT PRIMARY KEY REFERENCES runtime_actions(id), causal_fingerprint TEXT NOT NULL UNIQUE, provider_key TEXT NOT NULL, connector TEXT NOT NULL, binding TEXT NOT NULL)",
      );
      await db.query(
        "CREATE TABLE IF NOT EXISTS runtime_freezes(intent_id TEXT PRIMARY KEY REFERENCES runtime_actions(id), reason TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL)",
      );
      await db.query(
        "CREATE TABLE IF NOT EXISTS runtime_agent_locks(semantic_hash TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES runtime_actions(id), agent_id TEXT NOT NULL, held_until DOUBLE PRECISION NOT NULL)",
      );
      await db.query(
        "CREATE TABLE IF NOT EXISTS runtime_agent_blocks(intent_id TEXT PRIMARY KEY REFERENCES runtime_actions(id), semantic_hash TEXT NOT NULL, agent_id TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL)",
      );
      await db.query(
        "CREATE TABLE IF NOT EXISTS runtime_webhooks(connector TEXT NOT NULL,event_id TEXT NOT NULL,created_at DOUBLE PRECISION NOT NULL,PRIMARY KEY(connector,event_id))",
      );
    });
  }
  private async audit(
    db: Driver,
    id: string,
    event: string,
    detail: string,
    now: number,
  ): Promise<void> {
    await db.query("INSERT INTO runtime_audit VALUES($1,$2,$3,$4,$5)", [
      randomUUID(),
      id,
      event,
      detail,
      now,
    ]);
  }
  async get(id: string, db: Driver = this.driver): Promise<RecordRow> {
    const row = (
      await db.query<RecordRow>("SELECT * FROM runtime_actions WHERE id=$1", [
        id,
      ])
    )[0];
    if (!row) throw new RuntimeError("NOT_FOUND");
    return row;
  }
  async register(
    raw: Intent,
    connector: Connector,
    now = Date.now(),
  ): Promise<RecordRow> {
    const intent = intentSchema.parse(raw);
    if (intent.connector !== connector.id)
      throw new RuntimeError("CONNECTOR_MISMATCH");
    const input = connector.parse(intent.operation, intent.input);
    const causal = intent.causal ? causalFingerprint(intent) : null;
    const key = connector.key(causal ?? intent.id);
    const fingerprint = digest(
      canonical({
        operation: intent.operation,
        input,
        connector: connector.id,
        binding: connector.binding,
        key,
        ...(causal ? { causal } : {}),
      }),
    );
    return this.driver.transaction(async (db) => {
      await db.query(
        "INSERT INTO runtime_actions(id,connector,operation,input,fingerprint,provider_key,binding,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING_APPROVAL',$8,$9) ON CONFLICT DO NOTHING",
        [
          intent.id,
          connector.id,
          intent.operation,
          canonical(input),
          fingerprint,
          key,
          connector.binding,
          now,
          now,
        ],
      );
      const rows = await db.query<RecordRow>(
        "SELECT * FROM runtime_actions WHERE id=$1",
        [intent.id],
      );
      const row = rows[0];
      if (!row) throw new RuntimeError("PROVIDER_KEY_CONFLICT");
      if (row.fingerprint !== fingerprint)
        throw new RuntimeError("INTENT_CONFLICT");
      if (causal) {
        await db.query(
          "INSERT INTO runtime_causal_map(intent_id,causal_fingerprint,provider_key,connector,binding) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [intent.id, causal, key, connector.id, connector.binding],
        );
        const mapping = (
          await db.query<{ causal_fingerprint: string; provider_key: string }>(
            "SELECT causal_fingerprint,provider_key FROM runtime_causal_map WHERE intent_id=$1",
            [intent.id],
          )
        )[0];
        if (
          !mapping ||
          mapping.causal_fingerprint !== causal ||
          mapping.provider_key !== key
        )
          throw new RuntimeError("CAUSAL_MAPPING_CONFLICT");
      }
      return row;
    });
  }
  async decide(
    id: string,
    decision: "approve" | "reject",
    actor: string,
    reason: string,
    now = Date.now(),
  ): Promise<RecordRow> {
    if (
      !actor.trim() ||
      actor.length > 80 ||
      !reason.trim() ||
      reason.length > 300
    )
      throw new RuntimeError("INVALID_DECISION");
    return this.driver.transaction(async (db) => {
      const changed = await db.query<RecordRow>(
        "UPDATE runtime_actions SET approval=$1,status=$2,actor=$3,reason=$4,updated_at=$5 WHERE id=$6 AND status='PENDING_APPROVAL' AND approval IS NULL RETURNING *",
        [
          decision,
          decision === "approve" ? "READY" : "REJECTED",
          actor,
          reason,
          now,
          id,
        ],
      );
      if (changed[0]) {
        await this.audit(db, id, "DECISION_RECORDED", decision, now);
        return changed[0];
      }
      const row = await this.get(id, db);
      if (row.approval !== decision) throw new RuntimeError("DECISION_FINAL");
      return row;
    });
  }
  async claim(
    id: string,
    mode: "execute" | "reconcile",
    leaseMs: number,
    now = Date.now(),
  ): Promise<RecordRow | null> {
    const owner = randomUUID();
    return this.driver.transaction(async (db) => {
      const condition =
        mode === "execute"
          ? "status='READY' AND attempts=0 AND (error IS NULL OR error <> 'MUTATED_PAYLOAD') AND NOT EXISTS (SELECT 1 FROM runtime_agent_blocks AS blocked WHERE blocked.intent_id=runtime_actions.id)"
          : "attempts>0 AND next_check<=$4 AND ((status='UNKNOWN' AND (owner IS NULL OR lease_until<=$4)) OR (status='RUNNING' AND lease_until<=$4))";
      const status = mode === "execute" ? "RUNNING" : "UNKNOWN";
      const extra =
        mode === "execute" ? ",attempts=attempts+1" : ",checks=checks+1";
      const rows = await db.query<RecordRow>(
        "UPDATE runtime_actions SET owner=$1,fence=fence+1,lease_until=$2,status=$3,updated_at=$4" +
          extra +
          " WHERE id=$5 AND approval='approve' AND (" +
          condition +
          ") RETURNING *",
        [owner, now + leaseMs, status, now, id],
      );
      if (!rows[0]) return null;
      await this.audit(
        db,
        id,
        mode === "execute" ? "EXECUTION_CLAIMED" : "RECONCILIATION_CLAIMED",
        String(rows[0].fence),
        now,
      );
      return rows[0];
    });
  }
  async acquireMultiAgentLock(
    intentId: string,
    semanticHash: string,
    agentId: string,
    windowMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    if (
      !/^[a-f0-9]{64}$/.test(semanticHash) ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(agentId) ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 0 ||
      windowMs > 86400000
    )
      throw new RuntimeError("INVALID_AGENT_LOCK");
    return this.driver.transaction(async (db) => {
      const action = await this.get(intentId, db);
      if (
        action.status !== "READY" ||
        action.approval !== "approve" ||
        action.attempts !== 0
      )
        throw new RuntimeError("INTENT_NOT_READY");
      const acquired = await db.query(
        "INSERT INTO runtime_agent_locks(semantic_hash,intent_id,agent_id,held_until) VALUES($1,$2,$3,$4) ON CONFLICT(semantic_hash) DO UPDATE SET intent_id=excluded.intent_id,agent_id=excluded.agent_id,held_until=excluded.held_until WHERE (runtime_agent_locks.intent_id=excluded.intent_id AND runtime_agent_locks.agent_id=excluded.agent_id) OR (runtime_agent_locks.held_until <= $5 AND EXISTS (SELECT 1 FROM runtime_actions AS owner_action WHERE owner_action.id=runtime_agent_locks.intent_id AND owner_action.status='SUCCEEDED')) RETURNING intent_id",
        [semanticHash, intentId, agentId, now + windowMs, now],
      );
      if (acquired.length) {
        await db.query("DELETE FROM runtime_agent_blocks WHERE intent_id=$1", [
          intentId,
        ]);
        return true;
      }
      // A competing agent for the owner's exact intent must not block the owner's claim.
      const owner = (
        await db.query<{ intent_id: string }>(
          "SELECT intent_id FROM runtime_agent_locks WHERE semantic_hash=$1",
          [semanticHash],
        )
      )[0];
      if (!owner) throw new RuntimeError("AGENT_LOCK_INCONSISTENT");
      if (owner.intent_id !== intentId) {
        await db.query(
          "INSERT INTO runtime_agent_blocks(intent_id,semantic_hash,agent_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(intent_id) DO UPDATE SET semantic_hash=excluded.semantic_hash,agent_id=excluded.agent_id,created_at=excluded.created_at",
          [intentId, semanticHash, agentId, now],
        );
      }
      await this.audit(
        db,
        intentId,
        "AGENT_COLLISION_LOCKED",
        semanticHash,
        now,
      );
      return false;
    });
  }
  async agentBlocked(id: string): Promise<boolean> {
    return (
      (
        await this.driver.query(
          "SELECT intent_id FROM runtime_agent_blocks WHERE intent_id=$1",
          [id],
        )
      ).length > 0
    );
  }
  async causalKey(id: string): Promise<string | null> {
    return (
      (
        await this.driver.query<{ causal_fingerprint: string }>(
          "SELECT causal_fingerprint FROM runtime_causal_map WHERE intent_id=$1",
          [id],
        )
      )[0]?.causal_fingerprint ?? null
    );
  }
  async freeze(id: string): Promise<void> {
    await this.driver.transaction(async (db) => {
      const row = await db.query(
        "UPDATE runtime_actions SET error=CASE WHEN status IN ('PENDING_APPROVAL','READY') THEN 'MUTATED_PAYLOAD' ELSE error END WHERE id=$1 RETURNING id",
        [id],
      );
      if (!row.length) throw new RuntimeError("NOT_FOUND");
      const inserted = await db.query(
        "INSERT INTO runtime_freezes(intent_id,reason,created_at) VALUES($1,'MUTATED_PAYLOAD',$2) ON CONFLICT DO NOTHING RETURNING intent_id",
        [id, Date.now()],
      );
      if (inserted.length)
        await this.audit(
          db,
          id,
          "INTENT_FROZEN",
          "MUTATED_PAYLOAD",
          Date.now(),
        );
    });
  }
  async frozen(id: string): Promise<boolean> {
    return (
      (
        await this.driver.query(
          "SELECT intent_id FROM runtime_freezes WHERE intent_id=$1",
          [id],
        )
      ).length > 0
    );
  }
  async bind(
    row: RecordRow,
    reference: string,
    now = Date.now(),
  ): Promise<void> {
    if (!reference || reference.length > 256)
      throw new RuntimeError("INVALID_REFERENCE");
    const changed = await this.driver.query(
      "UPDATE runtime_actions SET reference=$1 WHERE id=$2 AND owner=$3 AND fence=$4 AND lease_until>$5 AND (reference IS NULL OR reference=$6) RETURNING id",
      [reference, row.id, row.owner, row.fence, now, reference],
    );
    if (!changed.length) throw new RuntimeError("STALE_OWNER");
  }
  async finish(
    row: RecordRow,
    outcome: Evidence,
    nextCheck: number,
    now = Date.now(),
  ): Promise<RecordRow> {
    return this.driver.transaction(async (db) => {
      const status =
        outcome.kind === "succeeded"
          ? "SUCCEEDED"
          : outcome.kind === "rejected"
            ? "REJECTED"
            : "UNKNOWN";
      const reference = outcome.reference ?? row.reference;
      const changed = await db.query<RecordRow>(
        "UPDATE runtime_actions SET status=$1,result=$2,error=$3,reference=COALESCE($4,reference),owner=NULL,lease_until=0,next_check=$5,updated_at=$6 WHERE id=$7 AND owner=$8 AND fence=$9 AND lease_until>$10 AND status IN ('RUNNING','UNKNOWN') AND (reference IS NULL OR reference=COALESCE($4,reference)) RETURNING *",
        [
          status,
          outcome.kind === "succeeded" ? canonical(outcome.result) : null,
          outcome.kind === "succeeded" ? null : outcome.code,
          reference,
          nextCheck,
          now,
          row.id,
          row.owner,
          row.fence,
          now,
        ],
      );
      if (!changed[0]) throw new RuntimeError("STALE_OWNER");
      await this.audit(
        db,
        row.id,
        "OUTCOME_" + status,
        outcome.kind === "succeeded" ? outcome.reference : outcome.code,
        now,
      );
      return changed[0];
    });
  }
  async due(now = Date.now(), limit = 50): Promise<RecordRow[]> {
    return this.driver.query<RecordRow>(
      "SELECT * FROM runtime_actions WHERE approval='approve' AND attempts>0 AND next_check<=$1 AND ((status='UNKNOWN' AND (owner IS NULL OR lease_until<=$2)) OR (status='RUNNING' AND lease_until<=$3)) ORDER BY next_check,created_at,id LIMIT $4",
      [now, now, now, limit],
    );
  }
  async enqueueWebhook(
    connector: string,
    eventId: string,
    key: string,
    now = Date.now(),
  ): Promise<void> {
    await this.driver.transaction(async (db) => {
      const inserted = await db.query(
        "INSERT INTO runtime_webhooks VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",
        [connector, eventId, now],
      );
      if (!inserted.length) return;
      const changed = await db.query<RecordRow>(
        "UPDATE runtime_actions SET next_check=0 WHERE connector=$1 AND provider_key=$2 AND status IN ('UNKNOWN','RUNNING') RETURNING *",
        [connector, key],
      );
      if (changed[0])
        await this.audit(db, changed[0].id, "WEBHOOK_QUEUED", eventId, now);
    });
  }
}
