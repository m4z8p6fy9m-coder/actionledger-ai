/** Isolated, assertion-backed reproduction. Never opens runtime data or contacts a model. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProvider } from "../apps/provider/src/app.ts";
import { buildServer } from "../apps/server/src/app.ts";
const dir = await mkdtemp(join(tmpdir(), "actionledger-reproduction-"));
let provider;
let server;
const headers = { authorization: "Bearer isolated-demo-operator" };
try {
  provider = buildProvider(
    join(dir, "provider.sqlite"),
    "isolated-demo-provider",
  );
  const providerUrl = await provider.app.listen({ host: "127.0.0.1", port: 0 });
  const config = {
    file: join(dir, "ledger.sqlite"),
    apiToken: "isolated-demo-operator",
    providerToken: "isolated-demo-provider",
    providerUrl,
  };
  server = await buildServer(config);
  async function request(url, payload) {
    const response = await server.app.inject({
      method: "POST",
      url: "/api" + url,
      headers,
      payload,
    });
    assert.ok(response.statusCode < 400, response.body);
    return response.json();
  }
  for (const mode of ["idempotent", "unprotected"]) {
    const baseline = provider.store.snapshot().paymentCount;
    const { action } = await request("/actions", {
      idempotencyKey: "reproduction-" + mode,
      recipient: "Offline demonstration",
      amountCents: 1000,
      currency: "EUR",
      providerMode: mode,
      description: "Isolated reproducible crash",
    });
    // This CLI is an explicit demonstration operator, never an autonomous tool approval.
    await request("/actions/" + action.id + "/approval", {
      decision: "approve",
      actor: "Reproduction operator",
      reason: "Explicit approval for isolated simulated payment",
    });
    const crashed = await request("/actions/" + action.id + "/execute", {
      simulateCrash: true,
    });
    assert.equal(crashed.action.status, "UNKNOWN");
    assert.equal(crashed.action.receipt, null);
    assert.equal(provider.store.snapshot().paymentCount - baseline, 1);
    await server.app.close();
    server = await buildServer(config);
    assert.equal(server.ledger.get(action.id).status, "UNKNOWN");
    const recovery = await server.app.inject({
      method: "POST",
      url: "/api/actions/" + action.id + "/recover",
      headers,
      payload: {},
    });
    assert.equal(recovery.statusCode, mode === "idempotent" ? 200 : 409);
    const final = server.ledger.get(action.id);
    assert.equal(final.status, mode === "idempotent" ? "SUCCEEDED" : "UNKNOWN");
    assert.equal(final.attempts, mode === "idempotent" ? 2 : 1);
    assert.equal(provider.store.snapshot().paymentCount - baseline, 1);
    console.log(
      JSON.stringify({
        mode,
        crash: "actual process.exit(86)",
        restart: "verified",
        status: final.status,
        attempts: final.attempts,
        externalPayments: 1,
        amountCents: 1000,
      }),
    );
  }
  console.log(
    "PASS: protected recovery deduplicates; unprotected uncertainty blocks replay.",
  );
} finally {
  if (server) await server.app.close();
  if (provider) await provider.app.close();
  await rm(dir, { recursive: true, force: true });
}
