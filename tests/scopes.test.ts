import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../apps/server/src/app.js";
import { buildProvider } from "../apps/provider/src/app.js";
let dir: string;
let server: Awaited<ReturnType<typeof buildServer>>;
let provider: ReturnType<typeof buildProvider>;
const operator = "operator-credential-for-tests-32-characters";
const agent = "agent-credential-for-tests-over-32-characters";
const payment = {
  idempotencyKey: "scoped-agent-invoice",
  recipient: "Scoped agent",
  amountCents: 1000,
  currency: "EUR",
  providerMode: "idempotent",
};
const headers = (token: string) => ({ authorization: "Bearer " + token });
const request = (
  token: string,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: headers(token),
    ...(payload === undefined ? {} : { payload }),
  });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "actionledger-scopes-"));
  provider = buildProvider(join(dir, "provider.sqlite"), "provider-scope-test");
  const providerUrl = await provider.app.listen({ host: "127.0.0.1", port: 0 });
  server = await buildServer({
    file: join(dir, "ledger.sqlite"),
    apiToken: operator,
    agentToken: agent,
    sessionBootstrap: false,
    providerToken: "provider-scope-test",
    providerUrl,
  });
});
afterEach(async () => {
  await server.app.close();
  await provider.app.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("scoped agent API with disabled browser credential bootstrap", () => {
  it("never discloses the operator token through session bootstrap", async () => {
    for (const token of ["", agent, operator]) {
      const response = await request(
        token,
        "GET",
        "/api/session?token=ignored",
      );
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(operator);
    }
  });
  it("allows intent creation and detail but requires a distinct operator approval", async () => {
    const created = await request(agent, "POST", "/api/actions", payment);
    expect(created.statusCode).toBe(201);
    const id = created.json().action.id;
    expect((await request(agent, "GET", "/api/actions/" + id)).statusCode).toBe(
      200,
    );
    const decision = {
      decision: "approve",
      actor: "Human reviewer",
      reason: "Verified separately",
    };
    expect(
      (
        await request(
          agent,
          "POST",
          "/api/actions/" + id + "/approval",
          decision,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await request(agent, "POST", "/api/actions/" + id + "/execute", {}))
        .statusCode,
    ).toBe(409);
    expect(provider.store.snapshot().paymentCount).toBe(0);
    expect(
      (
        await request(
          operator,
          "POST",
          "/api/actions/" + id + "/approval",
          decision,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(agent, "POST", "/api/actions/" + id + "/execute", {})
      ).json().action.status,
    ).toBe("SUCCEEDED");
    expect(provider.store.snapshot().paymentCount).toBe(1);
  });
  it("denies operator lists, exports, audits and query tricks to the agent credential", async () => {
    for (const url of [
      "/api/state",
      "/api/actions",
      "/api/action-page",
      "/api/actions/export",
      "/api/audit",
      "/api/state?scope=operator",
    ]) {
      expect((await request(agent, "GET", url)).statusCode).toBe(403);
    }
    expect((await request(operator, "GET", "/api/state")).statusCode).toBe(200);
    expect((await request("invalid", "GET", "/api/state")).statusCode).toBe(
      401,
    );
  });
  it("permits protected recovery using only the scoped execution credential", async () => {
    const id = (await request(agent, "POST", "/api/actions", payment)).json()
      .action.id;
    await request(operator, "POST", "/api/actions/" + id + "/approval", {
      decision: "approve",
      actor: "Human",
      reason: "Test crash review",
    });
    expect(
      (
        await request(agent, "POST", "/api/actions/" + id + "/execute", {
          simulateCrash: true,
        })
      ).json().action.status,
    ).toBe("UNKNOWN");
    expect(
      (
        await request(agent, "POST", "/api/actions/" + id + "/recover", {})
      ).json().action.status,
    ).toBe("SUCCEEDED");
    expect(provider.store.snapshot().paymentCount).toBe(1);
  });
  it("fails closed on insecure scoped-credential configurations", async () => {
    const config = {
      file: join(dir, "invalid.sqlite"),
      apiToken: operator,
      agentToken: agent,
      providerToken: "provider",
      providerUrl: "http://127.0.0.1:1",
    };
    await expect(buildServer(config)).rejects.toThrow(
      "disabled session bootstrap",
    );
    await expect(
      buildServer({ ...config, sessionBootstrap: false, agentToken: operator }),
    ).rejects.toThrow("distinct");
    await expect(
      buildServer({ ...config, sessionBootstrap: false, agentToken: "short" }),
    ).rejects.toThrow("32+");
  });
});
