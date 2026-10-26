/** Destructive fault injection is limited to this script's own PostgreSQL sessions and fixture records. */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { strict as assert } from "node:assert";
import { PostgresDriver, type Driver, type Value } from "../src/driver.js";
import { ActionStore } from "../src/store.js";
import { ActionEngine } from "../src/engine.js";
import { stripeFixture } from "./stripe-fixture.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || process.env.CHAOS_DISPOSABLE !== "YES")
  throw new Error(
    "Set TEST_DATABASE_URL and CHAOS_DISPOSABLE=YES for a disposable local PostgreSQL database",
  );
const parsed = new URL(database);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
  throw new Error("Chaos test accepts only a local database");
const base = new PostgresDriver(database);
const killer = new PostgresDriver(database);
let killed = 0;
let finishes = 0;
const faultDriver: Driver = {
  dialect: "postgres",
  query: <T extends object>(sql: string, values?: readonly Value[]) =>
    base.query<T>(sql, values),
  close: () => base.close(),
  transaction: <T>(fn: (connection: Driver) => Promise<T>) =>
    base.transaction(async (connection) => {
      let isFinish = false;
      const wrapper: Driver = {
        ...connection,
        query: async <R extends object>(
          sql: string,
          values?: readonly Value[],
        ) => {
          if (sql.startsWith("UPDATE runtime_actions SET status=$1,result=$2"))
            isFinish = true;
          return connection.query<R>(sql, values);
        },
      };
      const value = await fn(wrapper);
      if (isFinish && finishes++ % 2 === 0) {
        const pid = (
          await connection.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid",
          )
        )[0].pid;
        const result = await killer.query<{ terminated: boolean }>(
          "SELECT pg_terminate_backend($1) AS terminated",
          [pid],
        );
        if (!result[0].terminated)
          throw new Error("Could not inject session termination");
        killed++;
      }
      return value;
    }),
};
const fixture = await stripeFixture();
fixture.mode({ drop: true });
const store = new ActionStore(faultDriver);
const ids: string[] = [];
try {
  await store.initialize();
  const engine = new ActionEngine(store, [fixture.connector], {
    timeoutMs: 1000,
    leaseMs: 1500,
  });
  for (let i = 0; i < 24; i++) {
    const id = "chaos-" + randomUUID();
    ids.push(id);
    await engine.prepare({
      id,
      connector: "stripe",
      operation: "payment.create",
      input: {
        amountCents: 1000,
        currency: "eur",
        customer: "cus_fixture",
        paymentMethod: "pm_fixture",
      },
    });
    await store.decide(
      id,
      "approve",
      "Chaos fixture",
      "Disposable simulated payment",
    );
  }
  await Promise.allSettled(ids.map((id) => engine.invoke(id)));
  assert(killed > 0, "No database session termination was injected");
  assert.equal(fixture.counts().payments, ids.length);
  assert.equal(fixture.counts().posts, ids.length);
  await sleep(1700);
  await Promise.allSettled(ids.map((id) => engine.reconcile(id)));
  await Promise.allSettled(ids.map((id) => engine.invoke(id)));
  const rows = await Promise.all(ids.map((id) => store.get(id)));
  assert(
    rows.every(
      (row) =>
        row.attempts === 1 && ["UNKNOWN", "SUCCEEDED"].includes(row.status),
    ),
  );
  assert.equal(fixture.counts().payments, ids.length);
  assert.equal(fixture.counts().posts, ids.length);
  process.stdout.write(
    JSON.stringify({
      actions: ids.length,
      posts: fixture.counts().posts,
      payments: fixture.counts().payments,
      terminatedSessions: killed,
      unknown: rows.filter((row) => row.status === "UNKNOWN").length,
      succeeded: rows.filter((row) => row.status === "SUCCEEDED").length,
    }) + "\n",
  );
} finally {
  await fixture.close();
  await Promise.all([base.close(), killer.close()]);
}
