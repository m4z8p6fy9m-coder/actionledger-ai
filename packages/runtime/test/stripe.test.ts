import { afterEach, describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { causalFingerprint, type Intent } from "../src/contracts.js";
import { ActionEngine, RecoveryLoop } from "../src/engine.js";
import { ActionStore } from "../src/store.js";
import { SqliteDriver } from "../src/driver.js";
import { StripeConnector } from "../src/stripe.js";
import { createRuntimeHttp } from "../src/http.js";
import {
  stripeFixture,
  stripeConfig,
  webhookSecret,
} from "./stripe-fixture.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});
const intent = {
  id: "stripe-invoice",
  connector: "stripe",
  operation: "payment.create",
  input: {
    amountCents: 1000,
    currency: "eur",
    customer: "cus_fixture",
    paymentMethod: "pm_fixture",
  },
};
async function setup(file = ":memory:") {
  const provider = await stripeFixture();
  cleanup.push(provider.close);
  const driver = new SqliteDriver(file);
  cleanup.push(() => driver.close());
  const store = new ActionStore(driver);
  await store.initialize();
  const engine = new ActionEngine(store, [provider.connector]);
  await engine.prepare(intent);
  await store.decide(
    intent.id,
    "approve",
    "Operator",
    "Reviewed exact invoice",
  );
  return { provider, driver, store, engine };
}
async function due(store: ActionStore) {
  await store.driver.query(
    "UPDATE runtime_actions SET next_check=0,lease_until=0",
  );
}
describe("official Stripe adapter over local HTTP", () => {
  it("derives a stable account-scoped key and caches a sanitized successful receipt", async () => {
    const { provider, store, engine } = await setup();
    expect(provider.connector.key(intent.id)).toBe(
      provider.connector.key(intent.id),
    );
    expect(
      new StripeConnector(provider.client, {
        ...stripeConfig,
        namespace: "other",
      }).key(intent.id),
    ).not.toBe(provider.connector.key(intent.id));
    const row = await engine.invoke(intent.id);
    expect(row.status).toBe("SUCCEEDED");
    expect(row.result).not.toContain("client_secret");
    await engine.invoke(intent.id);
    expect(provider.counts().posts).toBe(1);
    expect(provider.payment()?.metadata.actionledger_key).toBe(
      (await store.get(intent.id)).provider_key,
    );
  });
  it.each([409, 429, 500])(
    "preserves UNKNOWN for ambiguous Stripe HTTP %s responses",
    async (status) => {
      const { provider, engine } = await setup();
      provider.mode({ errorStatus: status });
      const row = await engine.invoke(intent.id);
      expect(row.status).toBe("UNKNOWN");
      expect(row.error).toBe(
        status === 409
          ? "STRIPE_CONFLICT"
          : status === 429
            ? "STRIPE_RATE_LIMIT"
            : "STRIPE_SERVER_ERROR",
      );
      await engine.invoke(intent.id);
      expect(provider.counts().posts).toBe(1);
    },
  );
  it("reconciles response loss after commit without a second POST", async () => {
    const { provider, engine, store } = await setup();
    provider.mode({ drop: true });
    expect((await engine.invoke(intent.id)).status).toBe("UNKNOWN");
    expect(provider.counts().payments).toBe(1);
    provider.mode({});
    await due(store);
    await new RecoveryLoop(engine).tick();
    expect((await store.get(intent.id)).status).toBe("SUCCEEDED");
    expect(provider.counts()).toEqual({ posts: 1, reads: 2, payments: 1 });
  });
  it("never treats an empty eventual-consistency search as a failed payment", async () => {
    const { provider, engine, store } = await setup();
    provider.mode({ drop: true });
    await engine.invoke(intent.id);
    provider.mode({ hideSearch: true });
    await due(store);
    const row = await engine.reconcile(intent.id);
    expect(row.status).toBe("UNKNOWN");
    expect(row.error).toBe("STRIPE_SEARCH_NOT_FINAL");
    expect(provider.counts().posts).toBe(1);
  });
  it("accepts only terminal cancellation as rejection, not a nonterminal payment failure", async () => {
    const { provider, engine, store } = await setup();
    provider.mode({ status: "requires_payment_method" });
    expect((await engine.invoke(intent.id)).status).toBe("UNKNOWN");
    provider.update("canceled");
    await due(store);
    expect((await engine.reconcile(intent.id)).status).toBe("REJECTED");
    expect(provider.counts().posts).toBe(1);
  });
  it("rejects receipts that do not match the approved payment", async () => {
    const { provider, engine } = await setup();
    provider.mode({ corrupt: true });
    const row = await engine.invoke(intent.id);
    expect(row.status).toBe("UNKNOWN");
    expect(row.error).toBe("STRIPE_EVIDENCE_MISMATCH");
  });
  it("recovers a genuinely terminated worker from durable intent after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-stripe-crash-"));
    cleanup.push(() =>
      rm(dir, { recursive: true, force: true, maxRetries: 5 }),
    );
    const file = join(dir, "runtime.sqlite");
    const { provider, store } = await setup(file);
    const child = fork(
      fileURLToPath(new URL("./fixtures/stripe-crash.ts", import.meta.url)),
      [file, provider.url, intent.id],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Crash fixture timeout"));
      }, 15000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(code, stderr).toBe(86);
    expect(provider.counts().payments).toBe(1);
    expect((await store.get(intent.id)).status).toBe("RUNNING");
    // Advance the durable lease clock without waiting 30 seconds.
    await due(store);
    const reopened = new SqliteDriver(file);
    cleanup.push(() => reopened.close());
    const fresh = new ActionStore(reopened);
    await new RecoveryLoop(
      new ActionEngine(fresh, [provider.connector]),
    ).tick();
    expect((await fresh.get(intent.id)).status).toBe("SUCCEEDED");
    expect(provider.counts().posts).toBe(1);
  });
});
describe("Stripe webhook trust boundary", () => {
  const event = (
    provider: Awaited<ReturnType<typeof stripeFixture>>,
    id = "evt_fixture",
    type = "payment_intent.succeeded",
  ) =>
    JSON.stringify({
      id,
      object: "event",
      type,
      livemode: false,
      account: undefined,
      data: { object: provider.payment() },
    });
  it("verifies raw signatures and timestamp tolerance before touching the ledger", async () => {
    const { provider, store, engine } = await setup();
    await engine.invoke(intent.id);
    const body = event(provider);
    const signature = provider.client.webhooks.generateTestHeaderString({
      payload: body,
      secret: webhookSecret,
    });
    await expect(
      provider.connector.webhook(Buffer.from(body + " "), signature, store),
    ).rejects.toThrow("INVALID_STRIPE_SIGNATURE");
    const stale = provider.client.webhooks.generateTestHeaderString({
      payload: body,
      secret: webhookSecret,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    await expect(
      provider.connector.webhook(Buffer.from(body), stale, store),
    ).rejects.toThrow("INVALID_STRIPE_SIGNATURE");
    expect(
      await store.driver.query("SELECT * FROM runtime_webhooks"),
    ).toHaveLength(0);
  });
  it("deduplicates signed events and re-reads provider state instead of trusting event ordering", async () => {
    const { provider, store, engine } = await setup();
    provider.mode({ status: "processing" });
    await engine.invoke(intent.id);
    provider.update("succeeded");
    const body = event(provider, "evt_repeat", "payment_intent.payment_failed");
    const signature = provider.client.webhooks.generateTestHeaderString({
      payload: body,
      secret: webhookSecret,
    });
    await provider.connector.webhook(Buffer.from(body), signature, store);
    await provider.connector.webhook(Buffer.from(body), signature, store);
    expect(
      await store.driver.query("SELECT * FROM runtime_webhooks"),
    ).toHaveLength(1);
    await new RecoveryLoop(engine).tick();
    expect((await store.get(intent.id)).status).toBe("SUCCEEDED");
    expect(provider.counts().posts).toBe(1);
  });
  it("rejects a valid signature from the wrong account or live mode", async () => {
    const { provider, store, engine } = await setup();
    await engine.invoke(intent.id);
    const body = JSON.stringify({
      ...JSON.parse(event(provider)),
      account: "acct_other",
    });
    const signature = provider.client.webhooks.generateTestHeaderString({
      payload: body,
      secret: webhookSecret,
    });
    await expect(
      provider.connector.webhook(Buffer.from(body), signature, store),
    ).rejects.toThrow("STRIPE_ACCOUNT_MISMATCH");
  });
  it("enforces operator-only decisions and accepts webhook bytes on the real Fastify route", async () => {
    const { provider, store, engine } = await setup();
    provider.mode({ status: "processing" });
    await engine.invoke(intent.id);
    const operator = "o".repeat(40),
      agent = "a".repeat(40);
    const app = createRuntimeHttp(engine, new RecoveryLoop(engine), {
      operatorToken: operator,
      agentToken: agent,
      intentIds: [intent.id],
      stripe: provider.connector,
    });
    cleanup.push(() => app.close());
    const denied = await app.inject({
      method: "POST",
      url: "/v1/intents/" + intent.id + "/decision",
      headers: { authorization: "Bearer " + agent },
      payload: { decision: "approve", actor: "Agent", reason: "Self approval" },
    });
    expect(denied.statusCode).toBe(403);
    const body = event(provider);
    const signature = provider.client.webhooks.generateTestHeaderString({
      payload: body,
      secret: webhookSecret,
    });
    const valid = await app.inject({
      method: "POST",
      url: "/stripe/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload: body,
    });
    expect(valid.statusCode).toBe(202);
    const invalid = await app.inject({
      method: "POST",
      url: "/stripe/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "bad",
      },
      payload: body,
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      await store.driver.query("SELECT * FROM runtime_webhooks"),
    ).toHaveLength(1);
  });
  it("rejects malformed signed event envelopes", async () => {
    const { provider, store } = await setup();
    const body = JSON.stringify({
      id: "evt_malformed",
      type: "payment_intent.succeeded",
      livemode: false,
    });
    const signature = provider.client.webhooks.generateTestHeaderString({
      payload: body,
      secret: webhookSecret,
    });
    await expect(
      provider.connector.webhook(Buffer.from(body), signature, store),
    ).rejects.toThrow("INVALID_STRIPE_EVENT");
    expect(
      await store.driver.query("SELECT * FROM runtime_webhooks"),
    ).toHaveLength(0);
  });
  it("uses the durable causal mapping for Stripe idempotency", async () => {
    const { provider, store, engine } = await setup();
    const causalIntent: Intent = {
      ...intent,
      id: "stripe-causal",
      causal: { promptHash: "a".repeat(64), stateVector: { step: 1 } },
    };
    const row = await engine.prepare(causalIntent);
    expect(await store.causalKey(causalIntent.id)).toBe(
      causalFingerprint(causalIntent),
    );
    expect(row.provider_key).toBe(
      provider.connector.key(causalFingerprint(causalIntent)),
    );
    await store.decide(causalIntent.id, "approve", "Operator", "Reviewed");
    expect((await engine.invoke(causalIntent.id)).status).toBe("SUCCEEDED");
    expect(provider.payment()?.metadata.actionledger_key).toBe(
      row.provider_key,
    );
  });
});
