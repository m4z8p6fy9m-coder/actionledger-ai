import { resolve } from "node:path";
import { buildProvider } from "./app.js";
const token = process.env.PROVIDER_TOKEN;
if (!token) throw new Error("PROVIDER_TOKEN is required; use pnpm dev");
const { app } = buildProvider(
  resolve(process.env.DATA_DIR ?? "data", "provider.sqlite"),
  token,
);
await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PROVIDER_PORT ?? 4311),
});
console.log(
  "Payment provider listening on http://127.0.0.1:" +
    (process.env.PROVIDER_PORT ?? 4311),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
