/** Real SDK wiring, exercised locally without invoking a model. */
import { tool } from "@openai/agents";
import { z } from "zod";
import { makeLedgerPayment } from "./ledger-client.mjs";
export function createPaymentTool({ token, intentId, baseUrl }) {
  const pay = makeLedgerPayment({ token, intentId, baseUrl });
  return tool({
    name: "pay_invoice",
    description:
      "Request a payment for the host-assigned invoice intent. A separate human must approve it in ActionLedger. Reuse the same intent on resume.",
    parameters: z
      .object({
        recipient: z.string().trim().min(1).max(100),
        amountCents: z.number().int().min(1).max(100000000),
      })
      .strict(),
    // Do not disguise an ambiguous outcome as a successful tool result.
    errorFunction: null,
    execute: pay,
  });
}
// Bind intentId from durable host storage; never expose tokens or retry keys to the model.
