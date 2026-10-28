import { describe, expect, it } from "vitest";
import type { Action, Snapshot } from "../apps/web/src/api";
import {
  executionMessage,
  recentProviderEvidence,
  readDetailAfterMutation,
} from "../apps/web/src/lib/presentation";

const action = (status: Action["status"]): Action => ({
  id: "action-1",
  idempotency_key: "payment-key",
  payload: "{}",
  status,
  risk: "HIGH",
  attempts: 1,
  lease_until: null,
  receipt: null,
  error: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

describe("durable action presentation", () => {
  it("warns that a successful mutation may have changed state when its follow-up read fails", async () => {
    await expect(
      readDetailAfterMutation(async () => {
        throw new Error("internal details");
      }),
    ).rejects.toThrow(
      "The request completed, but action details could not be refreshed. Inspect the ledger before taking further action.",
    );
  });
  it("does not claim a crash or a new payment when the API returned cached success", () => {
    const message = executionMessage(
      { action: action("SUCCEEDED"), crashed: false, cached: true },
      true,
    );
    expect(message).toContain("previously recorded");
    expect(message).toContain("no new payment");
  });

  it("describes an actual crash as uncertainty and does not label unknown as success", () => {
    const result = { action: action("UNKNOWN"), crashed: true, cached: false };
    expect(executionMessage(result, false)).toContain("UNKNOWN");
    expect(executionMessage({ ...result, crashed: false }, true)).not.toContain(
      "recorded the result",
    );
  });

  it("distinguishes an unavailable provider from an empty recent receipt window", () => {
    expect(recentProviderEvidence(null, action("UNKNOWN"))).toMatchObject({
      count: null,
    });
    const provider: NonNullable<Snapshot["provider"]> = {
      payments: [],
      paymentCount: 201,
      totalCents: 201000,
      requestCount: 201,
      deduplicated: 0,
    };
    const evidence = recentProviderEvidence(provider, action("UNKNOWN"));
    expect(evidence.count).toBe(0);
    expect(evidence.empty).toContain("does not prove");
  });
});
