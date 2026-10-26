import { resolve } from "node:path";
import { buildServer } from "./app.js";
const apiToken = process.env.API_TOKEN;
const providerToken = process.env.PROVIDER_TOKEN;
if (!apiToken || !providerToken)
  throw new Error("Local credentials missing; start with pnpm dev");
const { app } = await buildServer({
  file: resolve(process.env.DATA_DIR ?? "data", "ledger.sqlite"),
  apiToken,
  agentToken: process.env.AGENT_TOKEN,
  sessionBootstrap: process.env.HEADLESS !== "true",
  providerToken,
  providerUrl: process.env.PROVIDER_URL ?? "http://127.0.0.1:4311",
  staticRoot:
    process.env.NODE_ENV === "production" && process.env.HEADLESS !== "true"
      ? resolve("apps/web/dist")
      : undefined,
});
await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.API_PORT ?? 4310),
});
console.log(
  "ActionLedger API listening on http://127.0.0.1:" +
    (process.env.API_PORT ?? 4310),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
