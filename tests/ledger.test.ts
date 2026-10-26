import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ledger,
  chargeHttp,
  PaymentProvider,
  MAX_ATTEMPTS,
  LEASE_MS,
  type Payment,
} from "@actionledger/core";
let dir: string;
let ledger: Ledger;
let provider: PaymentProvider;
const payment = (overrides: Partial<Payment> = {}) => ({
  idempotencyKey: "invoice-2026-001",
  recipient: "Alice",
  amountCents: 1000,
  currency: "EUR" as const,
  providerMode: "idempotent" as const,
  description: "Demo payment",
  ...overrides,
});
const createReady = (overrides: Partial<Payment> = {}) => {
  const { action } = ledger.create(payment(overrides));
  ledger.decide(action.id, "approve", "human", "Reviewed payment");
  return action.id;
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actionledger-"));
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  provider = new PaymentProvider(join(dir, "provider.sqlite"));
});
afterEach(() => {
  ledger.close();
  provider.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("durable action identity and approval", () => {
  it("deduplicates the same logical action and audits the duplicate", () => {
    const a = ledger.create(payment());
    const b = ledger.create(payment());
    expect(b.duplicate).toBe(true);
    expect(b.action.id).toBe(a.action.id);
    expect(ledger.snapshot().duplicates).toBe(1);
  });
  it("rejects key reuse with a changed amount, recipient, or provider policy", () => {
    ledger.create(payment());
    for (const diff of [
      { amountCents: 2000 },
      { recipient: "Bob" },
      { providerMode: "unprotected" as const },
    ])
      expect(() => ledger.create(payment(diff))).toThrow("different payload");
  });
  it("validates integer cents and rejects unknown fields", () => {
    for (const body of [
      payment({ amountCents: -1 }),
      payment({ amountCents: 1.5 }),
      { ...payment(), risk: "LOW" },
    ])
      expect(() => ledger.create(body)).toThrow();
  });
  it("requires explicit human approval for every payment", async () => {
    const { action } = ledger.create(payment());
    await expect(
      ledger.execute(action.id, async (p) => provider.charge(p)),
    ).rejects.toThrow("approval");
    expect(provider.snapshot().paymentCount).toBe(0);
  });
  it("persists approvals, receipts, attempts, and audit across restart", async () => {
    const id = createReady();
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    expect(ledger.get(id).status).toBe("READY");
    await ledger.execute(id, async (p) => provider.charge(p));
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    expect(ledger.get(id).status).toBe("SUCCEEDED");
    expect(ledger.detail(id).approval).toMatchObject({
      actor: "human",
      decision: "approve",
    });
    expect(ledger.detail(id).attempts).toHaveLength(1);
    expect(ledger.detail(id).audit.length).toBe(4);
  });
  it("keeps rejection durable and prevents execution", async () => {
    const { action } = ledger.create(payment());
    ledger.decide(action.id, "reject", "human", "Incorrect payee");
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    await expect(
      ledger.execute(action.id, async (p) => provider.charge(p)),
    ).rejects.toThrow();
    expect(() =>
      ledger.decide(action.id, "approve", "human", "Changed mind"),
    ).toThrow("cannot be changed");
    expect(provider.snapshot().paymentCount).toBe(0);
  });
  it("makes identical approval submissions idempotent", () => {
    const id = createReady();
    ledger.decide(id, "approve", "human", "Reviewed payment");
    expect(
      ledger.detail(id).audit.filter((e) => e.event === "APPROVED"),
    ).toHaveLength(1);
  });
});
describe("concurrency, uncertainty, and retry policy", () => {
  it("allows one claimant across two SQLite connections", () => {
    const id = createReady();
    const second = new Ledger(join(dir, "ledger.sqlite"));
    try {
      ledger.claim(id, "worker-a");
      expect(() => second.claim(id, "worker-b")).toThrow("lease");
      expect(ledger.get(id).attempts).toBe(1);
    } finally {
      second.close();
    }
  });
  it("returns cached success without calling the provider again", async () => {
    const id = createReady();
    await ledger.execute(id, async (p) => provider.charge(p));
    await ledger.execute(id, async () => {
      throw new Error("should not dispatch");
    });
    expect(provider.snapshot().paymentCount).toBe(1);
    expect(ledger.get(id).attempts).toBe(1);
  });
  it("keeps an active worker lease protected", () => {
    const id = createReady();
    ledger.claim(id, "owner", false, 1000);
    expect(ledger.expire(id, 1001).status).toBe("RUNNING");
  });
  it("marks an abandoned lease UNKNOWN after restart", () => {
    const id = createReady({ providerMode: "unprotected" });
    ledger.claim(id, "abandoned", false, 1000);
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    expect(ledger.expire(id, 1000 + LEASE_MS + 1).status).toBe("UNKNOWN");
    expect(() => ledger.claim(id, "unsafe", true)).toThrow("blocked");
  });
  it("treats network failures conservatively even if no receipt is observed", async () => {
    const id = createReady({ providerMode: "unprotected" });
    await expect(
      ledger.execute(id, async () => {
        throw new Error("Network timeout");
      }),
    ).rejects.toThrow("timeout");
    expect(ledger.get(id).status).toBe("UNKNOWN");
    await expect(
      ledger.execute(id, async (p) => provider.charge(p), { recovery: true }),
    ).rejects.toThrow("blocked");
  });
  it("recovers with the original key after a lost provider response", async () => {
    const id = createReady();
    await expect(
      ledger.execute(id, async (p) => {
        provider.charge(p);
        throw new Error("Response lost");
      }),
    ).rejects.toThrow();
    await ledger.execute(id, async (p) => provider.charge(p), {
      recovery: true,
    });
    expect(ledger.get(id).status).toBe("SUCCEEDED");
    expect(provider.snapshot()).toMatchObject({
      paymentCount: 1,
      requestCount: 2,
      deduplicated: 1,
    });
  });
  it("never retries an unprotected uncertain payment", async () => {
    const id = createReady({ providerMode: "unprotected" });
    await expect(
      ledger.execute(id, async (p) => {
        provider.charge(p);
        throw new Error("Response lost");
      }),
    ).rejects.toThrow();
    for (let i = 0; i < 3; i++)
      await expect(
        ledger.execute(id, async (p) => provider.charge(p), { recovery: true }),
      ).rejects.toThrow("blocked");
    expect(ledger.get(id)).toMatchObject({ status: "UNKNOWN", attempts: 1 });
    expect(provider.snapshot().paymentCount).toBe(1);
  });
  it("fences stale worker checkpoints after lease expiry and recovery", async () => {
    const id = createReady();
    let release!: () => void;
    let dispatched!: () => void;
    const started = new Promise<void>((r) => {
      dispatched = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = ledger.execute(
      id,
      async (p) => {
        const receipt = provider.charge(p);
        dispatched();
        await gate;
        return receipt;
      },
      { owner: "old" },
    );
    await started;
    ledger.expire(id, Date.now() + LEASE_MS + 1);
    await ledger.execute(id, async (p) => provider.charge(p), {
      owner: "new",
      recovery: true,
    });
    release();
    await expect(first).rejects.toThrow("lost ownership");
    expect(ledger.get(id).status).toBe("SUCCEEDED");
    expect(provider.snapshot().paymentCount).toBe(1);
  });
  it("bounds retries and preserves UNKNOWN when the budget is exhausted", async () => {
    const id = createReady();
    for (let i = 0; i < MAX_ATTEMPTS; i++)
      await expect(
        ledger.execute(
          id,
          async () => {
            throw new Error("Unavailable");
          },
          { recovery: i > 0 },
        ),
      ).rejects.toThrow();
    await expect(
      ledger.execute(id, async (p) => provider.charge(p), { recovery: true }),
    ).rejects.toThrow("limit");
    expect(ledger.get(id)).toMatchObject({
      status: "UNKNOWN",
      attempts: MAX_ATTEMPTS,
    });
  });
});
describe("separate provider guarantees", () => {
  it("persists provider deduplication over provider restarts", () => {
    const receipt = provider.charge(payment());
    provider.close();
    provider = new PaymentProvider(join(dir, "provider.sqlite"));
    expect(provider.charge(payment())).toEqual(receipt);
    expect(provider.snapshot().paymentCount).toBe(1);
  });
  it("rejects provider key reuse with different payloads", () => {
    provider.charge(payment());
    expect(() => provider.charge(payment({ amountCents: 2000 }))).toThrow(
      "another payload",
    );
  });
  it("demonstrates that an unprotected provider can create duplicate effects", () => {
    provider.charge(payment({ providerMode: "unprotected" }));
    provider.charge(payment({ providerMode: "unprotected" }));
    expect(provider.snapshot().paymentCount).toBe(2);
  });
});

describe("provider response binding", () => {
  it("does not checkpoint a receipt for a different approved payment", async () => {
    const id = createReady();
    const receipt = provider.charge(payment({ amountCents: 2000 }));
    const mocked = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(receipt), { status: 201 }),
      );
    try {
      await expect(
        ledger.execute(id, (p) =>
          chargeHttp("http://127.0.0.1:4311", "test", p),
        ),
      ).rejects.toThrow("does not match");
      expect(ledger.get(id)).toMatchObject({
        status: "UNKNOWN",
        receipt: null,
      });
    } finally {
      mocked.mockRestore();
    }
  });
});
