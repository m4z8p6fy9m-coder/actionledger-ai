import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { SqliteDriver, PostgresDriver, type Driver } from "../src/driver.js";
import { ActionStore } from "../src/store.js";
import { digest, type Connector } from "../src/contracts.js";
const url = process.env.TEST_DATABASE_URL;
if (
  url &&
  (process.env.ACTIONLEDGER_PROOF_DISPOSABLE !== "YES" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))
)
  throw new Error(
    "Use a disposable loopback database and ACTIONLEDGER_PROOF_DISPOSABLE=YES",
  );
const output = process.env.BENCH_OUTPUT;
if (!output) throw new Error("BENCH_OUTPUT is required and must not exist");
await mkdir("work", { recursive: true });
const database = join("work", "guard-bench-" + randomUUID() + ".sqlite");
// SQLite uses one synchronous connection: real concurrent independent connections require separate processes.
const drivers: Driver[] = url
  ? [new PostgresDriver(url), new PostgresDriver(url)]
  : [new SqliteDriver(database)];
const stores = drivers.map((driver) => new ActionStore(driver));
const connector: Connector = {
  id: "benchmark",
  binding: "bench-v1",
  key: (id) => "bench-" + id,
  parse: (_op, input) => input,
  execute: async () => ({ kind: "unknown", code: "NOT_EXECUTED" }),
  reconcile: async () => ({ kind: "unknown", code: "NOT_EXECUTED" }),
};
const prefix = "bench-" + randomUUID();
const results: unknown[] = [];
try {
  await stores[0].initialize();
  const dbVersion = (
    await stores[0].driver.query<{ v: string }>(
      url ? "SELECT version() AS v" : "SELECT sqlite_version() AS v",
    )
  )[0].v;
  for (const concurrency of [1, 4, 16])
    for (const scenario of ["conflict", "independent"] as const)
      for (let repetition = 1; repetition <= 3; repetition++) {
        const count = 48;
        const ids = Array.from(
          { length: count },
          (_, i) =>
            prefix +
            "-" +
            scenario +
            "-" +
            concurrency +
            "-" +
            repetition +
            "-" +
            i,
        );
        for (const id of ids) {
          await stores[0].register(
            { id, connector: "benchmark", operation: "write", input: {} },
            connector,
          );
          await stores[0].decide(
            id,
            "approve",
            "benchmark",
            "Disposable fixture",
          );
        }
        const sharedHash = digest(prefix + scenario + concurrency + repetition);
        const samples: Array<{ latencyMs: number; accepted: boolean }> = [];
        let cursor = 0;
        const started = performance.now();
        await Promise.all(
          Array.from({ length: concurrency }, async (_, worker) => {
            const store = stores[worker % stores.length];
            while (cursor < count) {
              const i = cursor++;
              const start = performance.now();
              const accepted = await store.acquireMultiAgentLock(
                ids[i],
                scenario === "conflict" ? sharedHash : digest(ids[i]),
                "agent-" + i,
                1000,
              );
              samples.push({ latencyMs: performance.now() - start, accepted });
            }
          }),
        );
        assert.equal(
          samples.filter((sample) => sample.accepted).length,
          scenario === "conflict" ? 1 : count,
        );
        const durationMs = performance.now() - started;
        const sorted = samples.map((x) => x.latencyMs).sort((a, b) => a - b);
        const percentile = (p: number) =>
          sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
        results.push({
          concurrency,
          scenario,
          repetition,
          count,
          durationMs,
          throughputPerSecond: count / (durationMs / 1000),
          accepted: samples.filter((s) => s.accepted).length,
          rejected: samples.filter((s) => !s.accepted).length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          samples,
        });
      }
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      osRelease: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      database: url ? "postgresql" : "sqlite",
      databaseVersion: dbVersion,
      driverInstances: drivers.length,
      maxConnectionsPerDriver: url ? 10 : 1,
      sqliteMode: url ? null : "single synchronous node:sqlite connection",
      windowMs: 1000,
      actionsPerTrial: 48,
      repetitions: 3,
      latencyScope:
        "guard acquisition only; excludes registration, approval, provider execution and network except local database",
    },
    results,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      output,
      database: report.environment.database,
      trials: results.length,
    }),
  );
} finally {
  await Promise.allSettled(drivers.map((d) => d.close()));
}
