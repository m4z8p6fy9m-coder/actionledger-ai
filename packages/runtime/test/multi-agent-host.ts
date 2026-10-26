import { PostgresDriver, SqliteDriver } from "../src/driver.js";
import { ActionStore } from "../src/store.js";
const intent = process.env.PROOF_INTENT;
const hash = process.env.PROOF_HASH;
const agent = process.env.PROOF_AGENT;
const sqlite = process.env.PROOF_SQLITE_FILE;
if (!intent || !hash || !agent || !sqlite || !process.send)
  throw new Error("This fixture must be launched by the proof runner");
const driver = process.env.TEST_DATABASE_URL
  ? new PostgresDriver(process.env.TEST_DATABASE_URL)
  : new SqliteDriver(sqlite);
const store = new ActionStore(driver);
process.on("message", async (message: unknown) => {
  if (message !== "start") return;
  try {
    const accepted = await store.acquireMultiAgentLock(intent, hash, agent, 0);
    process.send?.({ accepted });
  } catch (error) {
    process.send?.({
      error: error instanceof Error ? error.message : "UNKNOWN",
    });
  } finally {
    await driver.close();
    process.disconnect?.();
  }
});
process.send({ ready: true });
