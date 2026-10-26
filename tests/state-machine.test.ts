import { describe, expect, it } from "vitest";
import {
  Ledger,
  PaymentProvider,
  MAX_ATTEMPTS,
  type Payment,
} from "@actionledger/core";
/** Seeded adversarial command sequences check invariants, not a copy of transition code. */
describe("seeded action-state exploration", () => {
  for (const seed of [1, 7, 42, 99, 5409, 65537, 1234567, 2147483647]) {
    it(
      "preserves external-effect and approval invariants for seed " + seed,
      async () => {
        const ledger = new Ledger(":memory:");
        const provider = new PaymentProvider(":memory:");
        let state = seed;
        const random = () => {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          return state >>> 0;
        };
        const approvals = new Set<string>();
        const rejections = new Set<string>();
        const intents: Array<{ id: string; input: Payment }> = [];
        try {
          for (let n = 0; n < 8; n++) {
            const input: Payment = {
              idempotencyKey: "explore." + seed + "." + n,
              recipient: "Synthetic " + n,
              amountCents: 1000,
              currency: "EUR",
              providerMode: n % 2 ? "unprotected" : "idempotent",
              description: "Seeded invariant exploration",
            };
            intents.push({ id: ledger.create(input).action.id, input });
          }
          for (let step = 0; step < 160; step++) {
            const intent = intents[random() % intents.length];
            const operation = random() % 7;
            const before = ledger.get(intent.id);
            const requestsBefore = provider.snapshot().requestCount;
            try {
              if (operation === 0) ledger.create(intent.input);
              else if (operation === 1)
                ledger.create({ ...intent.input, amountCents: 2000 });
              else if (operation === 2) {
                ledger.decide(
                  intent.id,
                  "approve",
                  "Explorer fixture",
                  "Synthetic review",
                );
                approvals.add(intent.id);
              } else if (operation === 3) {
                ledger.decide(
                  intent.id,
                  "reject",
                  "Explorer fixture",
                  "Synthetic veto",
                );
                rejections.add(intent.id);
              } else {
                const loseResponse = operation === 6;
                await ledger.execute(
                  intent.id,
                  async (payment) => {
                    const receipt = provider.charge(payment);
                    if (loseResponse) throw new Error("Injected lost response");
                    return receipt;
                  },
                  { recovery: operation !== 4 },
                );
              }
            } catch {
              /* Rejected commands and injected ambiguity are expected; inspect durable effects below. */
            }
            const after = ledger.get(intent.id);
            if (before.status === "SUCCEEDED") {
              expect(after.status).toBe("SUCCEEDED");
              expect(after.receipt).toBe(before.receipt);
              expect(provider.snapshot().requestCount).toBe(requestsBefore);
            }
            if (
              before.status === "UNKNOWN" &&
              intent.input.providerMode === "unprotected"
            ) {
              expect(after.status).toBe("UNKNOWN");
              expect(after.attempts).toBe(before.attempts);
              expect(provider.snapshot().requestCount).toBe(requestsBefore);
            }
            expect(after.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
            for (const candidate of intents) {
              const payments = provider
                .snapshot()
                .payments.filter(
                  (p) => p.logicalKey === candidate.input.idempotencyKey,
                );
              expect(payments.length).toBeLessThanOrEqual(1);
              if (payments.length)
                expect(approvals.has(candidate.id)).toBe(true);
              if (rejections.has(candidate.id)) {
                expect(payments).toHaveLength(0);
                expect(ledger.get(candidate.id).status).toBe("REJECTED");
              }
              if (!approvals.has(candidate.id))
                expect(ledger.get(candidate.id).attempts).toBe(0);
            }
          }
        } finally {
          ledger.close();
          provider.close();
        }
      },
    );
  }
});
