import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../apps/server/src/app.js";
import { buildProvider } from "../apps/provider/src/app.js";
import { Ledger } from "@actionledger/core";
let dir: string;
let server: Awaited<ReturnType<typeof buildServer>>;
let provider: ReturnType<typeof buildProvider>;
const auth = { authorization: "Bearer test-api-token" };
const body = {
  idempotencyKey: "http-payment-001",
  recipient: "Alice",
  amountCents: 1000,
  currency: "EUR",
  providerMode: "idempotent",
  description: "HTTP integration test",
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "actionledger-http-"));
  provider = buildProvider(join(dir, "provider.sqlite"), "test-provider-token");
  const address = await provider.app.listen({ host: "127.0.0.1", port: 0 });
  server = await buildServer({
    file: join(dir, "ledger.sqlite"),
    apiToken: "test-api-token",
    providerToken: "test-provider-token",
    providerUrl: address,
  });
});
afterEach(async () => {
  await server.app.close();
  await provider.app.close();
  rmSync(dir, { recursive: true, force: true });
});
const request = (method: "GET" | "POST", url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url,
    headers: auth,
    ...(payload === undefined ? {} : { payload }),
  });
async function ready(mode = "idempotent") {
  const created = await request("POST", "/api/actions", {
    ...body,
    providerMode: mode,
  });
  const id = created.json().action.id as string;
  const approved = await request("POST", "/api/actions/" + id + "/approval", {
    decision: "approve",
    actor: "test human",
    reason: "Explicit test approval",
  });
  expect(approved.statusCode).toBe(200);
  return id;
}
describe("validated local REST API", () => {
  it("requires a bearer token for ledger access", async () => {
    expect(
      (await server.app.inject({ method: "GET", url: "/api/state" }))
        .statusCode,
    ).toBe(401);
    expect((await request("GET", "/api/state")).statusCode).toBe(200);
  });
  it("rejects cross-origin and DNS rebinding requests", async () => {
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/session",
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/session",
          headers: { host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("rejects invalid bodies, ids, and unapproved execution", async () => {
    expect(
      (await request("POST", "/api/actions", { ...body, amountCents: 0 }))
        .statusCode,
    ).toBe(400);
    expect((await request("GET", "/api/actions/invalid")).statusCode).toBe(400);
    const created = await request("POST", "/api/actions", body);
    expect(
      (
        await request(
          "POST",
          "/api/actions/" + created.json().action.id + "/execute",
          {},
        )
      ).statusCode,
    ).toBe(409);
  });
  it("reports duplicate and conflict responses", async () => {
    expect((await request("POST", "/api/actions", body)).statusCode).toBe(201);
    expect((await request("POST", "/api/actions", body)).json().duplicate).toBe(
      true,
    );
    expect(
      (await request("POST", "/api/actions", { ...body, amountCents: 2000 }))
        .statusCode,
    ).toBe(409);
  });
  it("executes a payment through an actual child worker", async () => {
    const id = await ready();
    const response = await request(
      "POST",
      "/api/actions/" + id + "/execute",
      {},
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().action.status).toBe("SUCCEEDED");
    expect(provider.store.snapshot().paymentCount).toBe(1);
    const repeated = await request(
      "POST",
      "/api/actions/" + id + "/execute",
      {},
    );
    expect(repeated.json().cached).toBe(true);
    expect(provider.store.snapshot().paymentCount).toBe(1);
  });
  it("kills the worker after provider commit, then safely recovers exactly one payment", async () => {
    const id = await ready();
    const crashed = await request("POST", "/api/actions/" + id + "/execute", {
      simulateCrash: true,
    });
    expect(crashed.statusCode, crashed.body).toBe(200);
    expect(crashed.json()).toMatchObject({
      crashed: true,
      action: { status: "UNKNOWN", receipt: null },
    });
    expect(provider.store.snapshot().paymentCount).toBe(1);
    await server.app.close();
    server = await buildServer({
      file: join(dir, "ledger.sqlite"),
      apiToken: "test-api-token",
      providerToken: "test-provider-token",
      providerUrl: provider.app.listeningOrigin,
    });
    const recovered = await request(
      "POST",
      "/api/actions/" + id + "/recover",
      {},
    );
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().action).toMatchObject({
      status: "SUCCEEDED",
      attempts: 2,
    });
    expect(provider.store.snapshot()).toMatchObject({
      paymentCount: 1,
      requestCount: 2,
      deduplicated: 1,
      totalCents: 1000,
    });
  });
  it("leaves unprotected payments UNKNOWN over restart and refuses all replay routes", async () => {
    const id = await ready("unprotected");
    const crashed = await request("POST", "/api/actions/" + id + "/execute", {
      simulateCrash: true,
    });
    expect(crashed.json().action.status).toBe("UNKNOWN");
    const reopened = new Ledger(join(dir, "ledger.sqlite"));
    expect(reopened.get(id).status).toBe("UNKNOWN");
    reopened.close();
    for (const route of ["execute", "recover"]) {
      const response = await request(
        "POST",
        "/api/actions/" + id + "/" + route,
        {},
      );
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("UNSAFE_RETRY");
    }
    expect(provider.store.snapshot().paymentCount).toBe(1);
    expect(server.ledger.get(id).attempts).toBe(1);
  });
  it("protects the provider endpoint independently", async () => {
    const response = await provider.app.inject({
      method: "POST",
      url: "/payments",
      payload: body,
    });
    expect(response.statusCode).toBe(401);
  });
  it("offers paginated actions and a monotonic audit cursor", async () => {
    await ready();
    expect(
      (await request("GET", "/api/actions?limit=1&offset=0")).json(),
    ).toHaveLength(1);
    expect(
      (await request("GET", "/api/audit?after=0&limit=1")).json(),
    ).toHaveLength(1);
    expect((await request("GET", "/api/actions?limit=9999")).statusCode).toBe(
      400,
    );
  });
});

describe("optional agent HTTP adapter, fully offline", () => {
  it("binds intent before dispatch, awaits a human, and caches resumed success", async () => {
    const { makeLedgerPayment } =
      await import("../examples/openai-agents-sdk/ledger-client.mjs");
    const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const pay = makeLedgerPayment({
      baseUrl: address,
      token: "test-api-token",
      intentId: "durable-invoice-101",
    });
    const pending = await pay({ recipient: "Alice", amountCents: 1000 });
    expect(pending.status).toBe("PENDING_APPROVAL");
    expect(provider.store.snapshot().paymentCount).toBe(0);
    await request("POST", "/api/actions/" + pending.actionId + "/approval", {
      decision: "approve",
      actor: "Human",
      reason: "Verified invoice",
    });
    const first = await pay({ recipient: "Alice", amountCents: 1000 });
    const resumed = await pay({ recipient: "Alice", amountCents: 1000 });
    expect(resumed).toEqual(first);
    expect(provider.store.snapshot().paymentCount).toBe(1);
    await expect(
      pay({ recipient: "Alice", amountCents: 2000 }),
    ).rejects.toThrow("different payload");
  });
  it("never bypasses a durable human rejection", async () => {
    const { makeLedgerPayment } =
      await import("../examples/openai-agents-sdk/ledger-client.mjs");
    const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const pay = makeLedgerPayment({
      baseUrl: address,
      token: "test-api-token",
      intentId: "rejected-invoice-102",
    });
    const pending = await pay({ recipient: "Alice", amountCents: 1000 });
    await request("POST", "/api/actions/" + pending.actionId + "/approval", {
      decision: "reject",
      actor: "Human",
      reason: "Invalid invoice",
    });
    expect(await pay({ recipient: "Alice", amountCents: 1000 })).toMatchObject({
      status: "REJECTED",
    });
    expect(provider.store.snapshot().paymentCount).toBe(0);
  });
  it("concurrent HTTP execution attempts create one external effect", async () => {
    const id = await ready();
    const results = await Promise.all([
      request("POST", "/api/actions/" + id + "/execute", {}),
      request("POST", "/api/actions/" + id + "/execute", {}),
    ]);
    expect(results.some((r) => r.statusCode === 200)).toBe(true);
    expect(provider.store.snapshot().paymentCount).toBe(1);
    expect(server.ledger.get(id)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
    });
  });
});

describe("worker supervision deadline", () => {
  it("terminates a stalled worker and preserves an uncertain claimed attempt", async () => {
    const id = await ready("unprotected");
    await server.app.close();
    const fixture = join(dir, "stalled-worker.mjs");
    const coreUrl = new URL("../packages/core/dist/index.js", import.meta.url)
      .href;
    writeFileSync(
      fixture,
      "import {Ledger} from " +
        JSON.stringify(coreUrl) +
        "; const [file,id,owner]=process.argv.slice(2); const l=new Ledger(file); l.claim(id,owner); l.close(); setInterval(()=>{},1000);",
    );
    server = await buildServer({
      file: join(dir, "ledger.sqlite"),
      apiToken: "test-api-token",
      providerToken: "test-provider-token",
      providerUrl: provider.app.listeningOrigin,
      workerPath: fixture,
      workerTimeoutMs: 1500,
    });
    const response = await request(
      "POST",
      "/api/actions/" + id + "/execute",
      {},
    );
    expect(response.statusCode).toBe(503);
    expect(server.ledger.get(id)).toMatchObject({
      status: "UNKNOWN",
      attempts: 1,
    });
    expect(provider.store.snapshot().paymentCount).toBe(0);
    expect(
      (await request("POST", "/api/actions/" + id + "/recover", {})).json()
        .error,
    ).toBe("UNSAFE_RETRY");
  });
});

describe("professional ledger browsing API", () => {
  it("returns full-history pagination metadata with literal search and compatible array listing", async () => {
    for (let n = 0; n < 3; n++)
      server.ledger.create({
        ...body,
        idempotencyKey: "query-api-" + n,
        recipient: n === 2 ? "Beta" : "Alpha",
      });
    const first = await request(
      "GET",
      "/api/action-page?q=Alpha&limit=1&sort=oldest",
    );
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
    });
    const next = await request(
      "GET",
      "/api/action-page?q=Alpha&limit=1&sort=oldest&offset=1",
    );
    expect(next.json()).toMatchObject({ total: 2, hasMore: false });
    expect(next.json().items[0].id).not.toBe(first.json().items[0].id);
    expect(
      (await request("GET", "/api/actions?q=Alpha&limit=1")).json(),
    ).toHaveLength(1);
  });
  it("exports a filtered CSV with safe headers and request correlation", async () => {
    server.ledger.create({
      ...body,
      idempotencyKey: "csv-api-alpha",
      recipient: "Alpha",
    });
    server.ledger.create({
      ...body,
      idempotencyKey: "csv-api-beta",
      recipient: "Beta",
    });
    const csv = await request("GET", "/api/actions/export?q=Alpha");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.headers["x-request-id"]).toBeTruthy();
    expect(csv.body).toContain("csv-api-alpha");
    expect(csv.body).not.toContain("csv-api-beta");
    expect(
      (await server.app.inject({ method: "GET", url: "/api/actions/export" }))
        .statusCode,
    ).toBe(401);
  });
  it("validates new search and export controls and correlates error responses", async () => {
    for (const route of [
      "/api/action-page?sort=DROP",
      "/api/action-page?q=" + "x".repeat(121),
      "/api/actions/export?limit=5",
    ]) {
      const response = await request("GET", route);
      expect(response.statusCode).toBe(400);
      expect(response.headers["x-request-id"]).toBeTruthy();
    }
  });
});
