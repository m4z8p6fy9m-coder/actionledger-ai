// Repository quickstart: use a stable, host-owned intent for every invocation.
import { readFile } from "node:fs/promises";
import { makeLedgerPayment } from "./ledger-client.mjs";

const intentId = process.argv[2];
const tokenFile = process.env.ACTIONLEDGER_AGENT_TOKEN_FILE;
if (!intentId || !tokenFile) {
  console.error(
    "Usage: set ACTIONLEDGER_AGENT_TOKEN_FILE, then run node examples/openai-agents-sdk/local-payment.mjs <durable-intent-id>",
  );
  process.exitCode = 1;
} else {
  try {
    const token = (await readFile(tokenFile, "utf8")).trim();
    const pay = makeLedgerPayment({ token, intentId });
    const result = await pay({
      recipient: "Demo recipient",
      amountCents: 1000,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Request failed; inspect the ledger before retrying.");
    console.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  }
}
