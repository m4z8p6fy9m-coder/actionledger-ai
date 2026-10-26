import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ledger,
  PaymentProvider,
  chargeHttp,
  LEASE_MS,
  type Payment,
} from "@actionledger/core";
import { buildServer } from "../apps/server/src/app.js";
let dir: string;
let ledger: Ledger;
let provider: PaymentProvider;
let transport: Server | undefined;
const body = (
  providerMode: Payment["providerMode"] = "idempotent",
): Payment => ({
  idempotencyKey: "fault-invoice-001",
  recipient: "Failure laboratory",
  amountCents: 1000,
  currency: "EUR",
  providerMode,
  description: "Deterministic fault injection",
});
function ready(mode: Payment["providerMode"] = "idempotent") {
  const { action } = ledger.create(body(mode));
  ledger.decide(
    action.id,
    "approve",
    "Test human",
    "Explicit fixture approval",
  );
  return action.id;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actionledger-fault-"));
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  provider = new PaymentProvider(join(dir, "provider.sqlite"));
});
afterEach(async () => {
  if (transport) {
    transport.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      transport!.close((e) => (e ? reject(e) : resolve())),
    );
    transport = undefined;
  }
  ledger.close();
  provider.close();
  rmSync(dir, { recursive: true, force: true });
});
async function faultEndpoint(
  fault: "drop" | "invalid" | "http500" | "timeout",
) {
  transport = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      provider.charge(JSON.parse(raw));
      // These failures happen AFTER the independent provider transaction commits.
      if (fault === "drop") {
        req.socket.destroy();
        return;
      }
      if (fault === "timeout") return;
      res.writeHead(fault === "http500" ? 500 : 201, {
        "content-type": "application/json",
      });
      res.end(
        fault === "invalid"
          ? '{"receipt":"truncated"}'
          : '{"error":"upstream checkpoint failed"}',
      );
    });
  });
  await new Promise<void>((resolve) =>
    transport!.listen(0, "127.0.0.1", resolve),
  );
  const address = transport.address();
  if (!address || typeof address === "string")
    throw new Error("No HTTP address");
  return "http://127.0.0.1:" + address.port;
}
describe("real HTTP ambiguity after provider commit", () => {
  for (const fault of ["drop", "invalid", "http500", "timeout"] as const) {
    for (const mode of ["idempotent", "unprotected"] as const) {
      it(
        fault +
          " / " +
          mode +
          " preserves uncertainty and applies the provider policy",
        async () => {
          const id = ready(mode);
          const address = await faultEndpoint(fault);
          await expect(
            ledger.execute(id, (p) => chargeHttp(address, "fixture-token", p)),
          ).rejects.toThrow();
          expect(ledger.get(id)).toMatchObject({
            status: "UNKNOWN",
            receipt: null,
            attempts: 1,
          });
          expect(provider.snapshot().paymentCount).toBe(1);
          // Reopen BOTH stores: durability and deduplication must survive the failed connection.
          ledger.close();
          provider.close();
          ledger = new Ledger(join(dir, "ledger.sqlite"));
          provider = new PaymentProvider(join(dir, "provider.sqlite"));
          if (mode === "idempotent") {
            await ledger.execute(id, async (p) => provider.charge(p), {
              recovery: true,
            });
            expect(ledger.get(id).status).toBe("SUCCEEDED");
            expect(provider.snapshot()).toMatchObject({
              paymentCount: 1,
              requestCount: 2,
              deduplicated: 1,
            });
          } else {
            await expect(
              ledger.execute(id, async (p) => provider.charge(p), {
                recovery: true,
              }),
            ).rejects.toThrow("blocked");
            expect(ledger.get(id)).toMatchObject({
              status: "UNKNOWN",
              attempts: 1,
            });
            expect(provider.snapshot()).toMatchObject({
              paymentCount: 1,
              requestCount: 1,
            });
          }
        },
      );
    }
  }
});
describe("failure positions and recovery concurrency", () => {
  it("fences a late old failure while a newer recovery still owns the action", async () => {
    const id = ready();
    let oldReject!: (reason: Error) => void;
    const old = ledger.execute(
      id,
      () =>
        new Promise((_, reject) => {
          oldReject = reject;
        }),
      { owner: "old-owner" },
    );
    const oldResult = old.catch((e) => e);
    ledger.expire(id, Date.now() + LEASE_MS + 1);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const recovery = ledger.execute(
      id,
      async (p) => {
        await gate;
        return provider.charge(p);
      },
      { owner: "new-owner", recovery: true },
    );
    oldReject(new Error("late connection reset"));
    expect((await oldResult).message).toBe("late connection reset");
    expect(ledger.get(id)).toMatchObject({
      status: "RUNNING",
      owner: "new-owner",
      attempts: 2,
    });
    finish();
    await recovery;
    expect(ledger.get(id).status).toBe("SUCCEEDED");
    expect(provider.snapshot().paymentCount).toBe(1);
    expect(ledger.detail(id).attempts.map((a) => a.outcome)).toEqual([
      "UNKNOWN",
      "SUCCEEDED",
    ]);
  });
  it("allows only one recovery owner across independently reopened connections", async () => {
    const id = ready();
    ledger.claim(id, "dead-worker", false, 1000);
    ledger.expire(id, 1000 + LEASE_MS + 1);
    const other = new Ledger(join(dir, "ledger.sqlite"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const first = ledger.execute(
        id,
        async (p) => {
          await gate;
          return provider.charge(p);
        },
        { owner: "recovery-a", recovery: true },
      );
      await expect(
        other.execute(id, async (p) => provider.charge(p), {
          owner: "recovery-b",
          recovery: true,
        }),
      ).rejects.toThrow("lease");
      release();
      await first;
      expect(ledger.get(id)).toMatchObject({
        status: "SUCCEEDED",
        attempts: 2,
      });
      expect(provider.snapshot().requestCount).toBe(1);
    } finally {
      other.close();
    }
  });
  for (const claimed of [false, true]) {
    for (const mode of ["idempotent", "unprotected"] as const) {
      it(
        "process exits " +
          (claimed ? "after claim" : "before claim") +
          " / " +
          mode,
        async () => {
          const id = ready(mode);
          const fixture = join(dir, "fault-worker.mjs");
          const core = new URL(
            "../packages/core/dist/index.js",
            import.meta.url,
          ).href;
          writeFileSync(
            fixture,
            "import {Ledger} from " +
              JSON.stringify(core) +
              ";const [file,id,owner]=process.argv.slice(2);const l=new Ledger(file);" +
              (claimed ? "l.claim(id,owner);" : "") +
              "l.close();process.exit(87);",
          );
          const server = await buildServer({
            file: join(dir, "ledger.sqlite"),
            apiToken: "fixture-api",
            providerToken: "fixture-provider",
            providerUrl: "http://127.0.0.1:1",
            workerPath: fixture,
          });
          try {
            const response = await server.app.inject({
              method: "POST",
              url: "/api/actions/" + id + "/execute",
              headers: { authorization: "Bearer fixture-api" },
              payload: {},
            });
            expect(response.statusCode).toBe(503);
            expect(ledger.get(id)).toMatchObject({
              status: claimed ? "UNKNOWN" : "READY",
              attempts: claimed ? 1 : 0,
            });
            if (claimed && mode === "unprotected") {
              await expect(
                ledger.execute(id, async (p) => provider.charge(p), {
                  recovery: true,
                }),
              ).rejects.toThrow("blocked");
              expect(provider.snapshot().paymentCount).toBe(0);
            } else {
              await ledger.execute(id, async (p) => provider.charge(p), {
                recovery: claimed,
              });
              expect(ledger.get(id).status).toBe("SUCCEEDED");
              expect(provider.snapshot().paymentCount).toBe(1);
            }
          } finally {
            await server.app.close();
          }
        },
      );
    }
  }
});

describe("custom adapter receipt contract", () => {
  it("does not accept a receipt for a different payment from a custom adapter", async () => {
    const id = ready();
    await expect(
      ledger.execute(id, async () =>
        provider.charge({ ...body(), amountCents: 2000 }),
      ),
    ).rejects.toThrow("does not match");
    expect(ledger.get(id)).toMatchObject({ status: "UNKNOWN", receipt: null });
  });
  it("rejects malformed evidence and leaves the committed external payment uncertain", async () => {
    const id = ready();
    await expect(
      ledger.execute(id, async (p) => ({
        ...provider.charge(p),
        id: "",
        createdAt: "not-a-date",
      })),
    ).rejects.toThrow();
    expect(ledger.get(id)).toMatchObject({ status: "UNKNOWN", receipt: null });
    expect(provider.snapshot().paymentCount).toBe(1);
  });
});
