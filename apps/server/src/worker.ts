import { Ledger, chargeHttp } from "@actionledger/core";
const [file, id, owner, recovery, crash] = process.argv.slice(2);
if (!file || !id || !owner || !process.env.PROVIDER_TOKEN)
  throw new Error("Worker configuration missing");
const ledger = new Ledger(file);
try {
  await ledger.execute(
    id,
    (p) =>
      chargeHttp(
        process.env.PROVIDER_URL ?? "http://127.0.0.1:4311",
        process.env.PROVIDER_TOKEN!,
        p,
      ),
    {
      owner,
      recovery: recovery === "true",
      afterCommit: () => {
        if (crash === "true") process.exit(86);
      },
    },
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Worker failed");
  process.exitCode = 1;
} finally {
  ledger.close();
}
