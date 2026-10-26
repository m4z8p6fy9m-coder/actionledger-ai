import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SqliteDriver,
  PostgresDriver,
  type Driver,
  type Value,
} from "../src/driver.js";
import { ActionStore } from "../src/store.js";
import { ActionEngine } from "../src/engine.js";
import { createGateway } from "../src/mcp.js";
import { canonical, digest, type Connector } from "../src/contracts.js";

const url = process.env.TEST_DATABASE_URL;
if (
  url &&
  (process.env.ACTIONLEDGER_PROOF_DISPOSABLE !== "YES" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))
)
  throw new Error(
    "Use a disposable loopback database and ACTIONLEDGER_PROOF_DISPOSABLE=YES",
  );
await mkdir("work", { recursive: true });
const file = join("work", "multi-agent-proof-" + randomUUID() + ".sqlite");
const makeDriver = (): Driver =>
  url ? new PostgresDriver(url) : new SqliteDriver(file);
const a = makeDriver(),
  b = makeDriver();
const one = new ActionStore(a),
  two = new ActionStore(b);
const prefix = "proof-" + randomUUID();
const ids = (name: string) => prefix + "-" + name;
const hash = (prompt: string, asset: string) =>
  digest(canonical({ version: 1, promptHash: prompt, assetId: asset }));
let effects = 0;
let release!: () => void;
const gate = new Promise<void>((r) => {
  release = r;
});
let started!: () => void;
const entered = new Promise<void>((r) => {
  started = r;
});
const connector: Connector = {
  id: "proof",
  binding: "proof-v1",
  key: (id) => "proof-" + id,
  parse: (_op, input) => input,
  execute: async (context) => {
    effects++;
    if (context.intent.id === ids("demoA")) {
      started();
      await gate;
    }
    if (context.intent.id === ids("unknownA"))
      return { kind: "unknown", code: "PROOF_RESPONSE_LOST" };
    return {
      kind: "succeeded",
      reference: "receipt-" + context.intent.id,
      result: { confirmed: true },
    };
  },
  reconcile: async () => ({ kind: "unknown", code: "NO_EVIDENCE" }),
};
const engineA = new ActionEngine(one, [connector], { multiAgentWindowMs: 0 });
const engineB = new ActionEngine(two, [connector], { multiAgentWindowMs: 0 });
const clients: Client[] = [];
async function prepare(id: string) {
  await engineA.prepare({
    id,
    connector: "proof",
    operation: "write",
    input: {},
  });
  await one.decide(
    id,
    "approve",
    "fixture operator",
    "Disposable simulated action",
  );
}
async function client(
  engine: ActionEngine,
  id: string,
  agentId: string,
  semanticHash: string,
) {
  const server = createGateway(engine, [id], {
    [id]: { agentId, semanticHash },
  });
  const c = new Client({ name: agentId, version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await c.connect(right);
  clients.push(c);
  return c;
}
async function raceHosts(
  intent: string,
  semanticHash: string,
): Promise<boolean[]> {
  const hostPath = fileURLToPath(
    new URL("./multi-agent-host.ts", import.meta.url),
  );
  const makeHost = (agent: string) => {
    const child = fork(hostPath, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: {
        ...process.env,
        PROOF_SQLITE_FILE: file,
        PROOF_INTENT: intent,
        PROOF_HASH: semanticHash,
        PROOF_AGENT: agent,
      },
    });
    let ready!: () => void;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let resolveResult!: (value: boolean) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<boolean>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    child.on("message", (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const message = data as {
        ready?: boolean;
        accepted?: boolean;
        error?: string;
      };
      if (message.ready) ready();
      if (typeof message.accepted === "boolean")
        resolveResult(message.accepted);
      if (message.error)
        rejectResult(new Error("Child host: " + message.error));
    });
    child.on("error", rejectResult);
    child.on("exit", (code) => {
      if (code !== 0) rejectResult(new Error("Child host exited: " + code));
    });
    return { child, prepared, result };
  };
  const hosts = [makeHost("agent-A"), makeHost("agent-B")];
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Host race timed out")), 20000).unref(),
  );
  let completed = false;
  try {
    await Promise.race([Promise.all(hosts.map((h) => h.prepared)), timeout]);
    hosts.forEach((h) => h.child.send("start"));
    const result = await Promise.race([
      Promise.all(hosts.map((h) => h.result)),
      timeout,
    ]);
    completed = true;
    return result;
  } finally {
    if (!completed)
      hosts.forEach(({ child }) => {
        if (child.exitCode === null) child.kill();
      });
  }
}
async function invoke(c: Client, id: string) {
  return c.callTool({
    name: "actionledger_invoke",
    arguments: { intentId: id },
  });
}
try {
  await one.initialize();
  for (const name of [
    "same",
    "minA",
    "minB",
    "raceA",
    "raceB",
    "other",
    "prompt",
    "tenantA",
    "tenantB",
    "unscopedA",
    "unscopedB",
    "stale",
    "demoA",
    "demoB",
    "unknownA",
    "unknownB",
    "failure",
  ])
    await prepare(ids(name));
  const same = hash("a".repeat(64), "asset-1");
  const differentAsset = hash("a".repeat(64), "asset-2");
  const differentPrompt = hash("b".repeat(64), "asset-1");
  const tenantA = hash(
    "a".repeat(64),
    JSON.stringify(["tenant-a", "invoice-42"]),
  );
  const tenantB = hash(
    "a".repeat(64),
    JSON.stringify(["tenant-b", "invoice-42"]),
  );
  assert.notEqual(tenantA, tenantB);
  assert.equal(
    await one.acquireMultiAgentLock(ids("tenantA"), tenantA, "agent-A", 0),
    true,
  );
  assert.equal(
    await two.acquireMultiAgentLock(ids("tenantB"), tenantB, "agent-B", 0),
    true,
  );
  const unqualified = hash("a".repeat(64), "invoice-42");
  assert.equal(
    await one.acquireMultiAgentLock(
      ids("unscopedA"),
      unqualified,
      "agent-A",
      0,
    ),
    true,
  );
  assert.equal(
    await two.acquireMultiAgentLock(
      ids("unscopedB"),
      unqualified,
      "agent-B",
      0,
    ),
    false,
  );
  console.log(
    "Tenant-qualified asset IDs isolate lock groups; identical unqualified IDs do not",
  );
  const minHash = hash("9".repeat(64), "minimum-window");
  assert.equal(
    await one.acquireMultiAgentLock(
      ids("minA"),
      minHash,
      "agent-A",
      1000,
      1000,
    ),
    true,
  );
  const minClaim = await one.claim(ids("minA"), "execute", 5000, 1001);
  assert(minClaim);
  await one.finish(
    minClaim,
    { kind: "succeeded", reference: "fixture-min", result: {} },
    0,
    1002,
  );
  assert.equal(
    await two.acquireMultiAgentLock(
      ids("minB"),
      minHash,
      "agent-B",
      1000,
      1999,
    ),
    false,
  );
  assert.equal(
    await two.acquireMultiAgentLock(
      ids("minB"),
      minHash,
      "agent-B",
      1000,
      2000,
    ),
    true,
  );
  console.log(
    "Confirmed success: transfer denied before minimum window, allowed at its boundary",
  );
  const sameIntentHash = hash("f".repeat(64), "same-intent");
  const sameIntent = await raceHosts(ids("same"), sameIntentHash);
  assert.equal(sameIntent.filter(Boolean).length, 1);
  assert.equal(await one.agentBlocked(ids("same")), false);
  const sameClaim = await one.claim(ids("same"), "execute", 10000);
  assert(sameClaim);
  await one.finish(
    sameClaim,
    { kind: "succeeded", reference: "fixture-same", result: {} },
    0,
  );
  console.log(
    "Same intent, two independent agent host processes: one lock owner; winner can claim and checkpoint",
  );
  const raced = url
    ? await Promise.all([
        one.acquireMultiAgentLock(ids("raceA"), same, "agent-A", 0),
        two.acquireMultiAgentLock(ids("raceB"), same, "agent-B", 0),
      ])
    : [
        await one.acquireMultiAgentLock(ids("raceA"), same, "agent-A", 0),
        await two.acquireMultiAgentLock(ids("raceB"), same, "agent-B", 0),
      ];
  assert.equal(raced.filter(Boolean).length, 1);
  const loser = ids(raced[0] ? "raceB" : "raceA");
  assert.equal((await engineB.invoke(loser)).attempts, 0);
  assert.equal(effects, 0);
  assert.equal(
    await two.acquireMultiAgentLock(ids("other"), differentAsset, "agent-B", 0),
    true,
  );
  assert.equal(
    await two.acquireMultiAgentLock(
      ids("prompt"),
      differentPrompt,
      "agent-B",
      0,
    ),
    true,
  );
  const old = await one.claim(ids("stale"), "execute", 1000, 1000);
  assert(old);
  const fresh = await two.claim(ids("stale"), "reconcile", 1000, 2001);
  assert(fresh);
  await assert.rejects(
    one.finish(
      old,
      { kind: "succeeded", reference: "stale", result: {} },
      0,
      2002,
    ),
    /STALE_OWNER/,
  );
  await two.finish(fresh, { kind: "unknown", code: "NO_EVIDENCE" }, 0, 2002);
  assert.equal((await one.get(ids("stale"))).status, "UNKNOWN");
  const demoHash = hash("c".repeat(64), "demo");
  const clientA = await client(engineA, ids("demoA"), "agent-A", demoHash);
  const clientB = await client(engineB, ids("demoB"), "agent-B", demoHash);
  const pending = invoke(clientA, ids("demoA"));
  await entered;
  try {
    const blocked = await invoke(clientB, ids("demoB"));
    assert.equal(
      (blocked.structuredContent as Record<string, unknown> | undefined)
        ?.statusCode,
      423,
    );
    assert.equal(await two.agentBlocked(ids("demoB")), true);
    const audit = await two.driver.query<{ event: string }>(
      "SELECT event FROM runtime_audit WHERE action_id=$1",
      [ids("demoB")],
    );
    assert(audit.some((row) => row.event === "AGENT_COLLISION_LOCKED"));
    assert.equal(effects, 1);
    const snapshot = await two.get(ids("demoB"));
    console.log(
      JSON.stringify({
        intentId: snapshot.id,
        ledgerStatus: snapshot.status,
        attempts: snapshot.attempts,
        blocked: await two.agentBlocked(snapshot.id),
        auditEvents: audit.map((entry) => entry.event),
      }),
    );
    console.log(
      "A acquired; B -> 423 AgentCollisionLock; block and audit persisted; B dispatched 0 times",
    );
  } finally {
    release();
  }
  assert.equal(
    ((await pending).structuredContent as Record<string, unknown> | undefined)
      ?.status,
    "SUCCEEDED",
  );
  assert.equal(
    (
      (await invoke(clientB, ids("demoB"))).structuredContent as
        Record<string, unknown> | undefined
    )?.status,
    "SUCCEEDED",
  );
  console.log(
    "A -> SUCCEEDED; B explicitly acquired and ran after the configured zero-ms minimum window",
  );
  const unknownHash = hash("d".repeat(64), "unknown");
  const unknownA = await client(
    engineA,
    ids("unknownA"),
    "agent-A",
    unknownHash,
  );
  const unknownB = await client(
    engineB,
    ids("unknownB"),
    "agent-B",
    unknownHash,
  );
  assert.equal(
    (
      (await invoke(unknownA, ids("unknownA"))).structuredContent as
        Record<string, unknown> | undefined
    )?.status,
    "UNKNOWN",
  );
  assert.equal(
    (
      (await invoke(unknownB, ids("unknownB"))).structuredContent as
        Record<string, unknown> | undefined
    )?.statusCode,
    423,
  );
  assert.equal((await one.get(ids("unknownA"))).status, "UNKNOWN");
  console.log(
    "UNKNOWN remains locked: inspect provider evidence; do not retry or edit the ledger to force a release",
  );
  const failDriver = makeDriver();
  const injected: Driver = {
    dialect: failDriver.dialect,
    query: <T extends object>(sql: string, values?: readonly Value[]) =>
      failDriver.query<T>(sql, values),
    close: () => failDriver.close(),
    transaction: <T>(fn: (connection: Driver) => Promise<T>) =>
      failDriver.transaction((connection) =>
        fn({
          ...connection,
          query: <R extends object>(sql: string, values?: readonly Value[]) => {
            if (sql.startsWith("INSERT INTO runtime_agent_locks"))
              throw new Error("INJECTED_CONFLICT_DATABASE_FAILURE");
            return connection.query<R>(sql, values);
          },
        }),
      ),
  };
  const failStore = new ActionStore(injected);
  const failingEngine = new ActionEngine(failStore, [connector]);
  const failClient = await client(
    failingEngine,
    ids("failure"),
    "agent-X",
    hash("e".repeat(64), "failure"),
  );
  const before = effects;
  const failed = await invoke(failClient, ids("failure"));
  assert.equal(failed.isError, true);
  assert.equal(effects, before);
  assert.equal((await one.get(ids("failure"))).attempts, 0);
  await failDriver.close();
  console.log(
    "Injected database error during collision check -> gateway error; no external effect",
  );
  console.log(
    JSON.stringify({
      database: url ? "postgresql" : "sqlite",
      fixtureDatabase: url
        ? "disposable PostgreSQL (configured by host)"
        : file,
      independentConnections: 2,
      independentHostProcesses: 2,
      sameIntentRace: "concurrent separate processes",
      distinctIntentRace: url
        ? "concurrent independent PostgreSQL pools"
        : "sequential in parent process",
      checks: [
        "same intent",
        "collision",
        "independent assets",
        "different prompt hashes",
        "host-qualified and unqualified tenants",
        "stale owner",
        "unknown",
        "success transfer and minimum window",
        "database failure",
      ],
      effects,
      status: "PASS",
    }),
  );
} finally {
  release();
  await Promise.allSettled(clients.map((c) => c.close()));
  await Promise.allSettled([a.close(), b.close()]);
}
