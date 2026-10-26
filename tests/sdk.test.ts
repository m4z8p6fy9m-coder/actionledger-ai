import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunContext, setTracingDisabled } from "@openai/agents";
import { buildServer } from "../apps/server/src/app.js";
import { buildProvider } from "../apps/provider/src/app.js";
import { createPaymentTool } from "../examples/openai-agents-sdk/tool.example.mjs";

setTracingDisabled(true);
let dir: string;
let server: Awaited<ReturnType<typeof buildServer>>;
let provider: ReturnType<typeof buildProvider>;
let baseUrl: string;
const token = "sdk-test-operator";
const input = { recipient: "SDK invoice", amountCents: 1000 };
const headers = { authorization: "Bearer " + token };
const factory = () =>
  createPaymentTool({ token, baseUrl, intentId: "persisted-sdk-invoice" });
const invoke = (tool = factory(), value = input) =>
  tool.invoke(new RunContext(), JSON.stringify(value));
async function decide(id: string, decision = "approve") {
  const response = await server.app.inject({
    method: "POST",
    url: "/api/actions/" + id + "/approval",
    headers,
    payload: {
      decision,
      actor: "Human reviewer",
      reason: "Reviewed outside SDK tool",
    },
  });
  expect(response.statusCode).toBe(200);
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "actionledger-sdk-"));
  provider = buildProvider(join(dir, "provider.sqlite"), "sdk-provider-token");
  const providerUrl = await provider.app.listen({ host: "127.0.0.1", port: 0 });
  server = await buildServer({
    file: join(dir, "ledger.sqlite"),
    apiToken: token,
    providerToken: "sdk-provider-token",
    providerUrl,
  });
  baseUrl = await server.app.listen({ host: "127.0.0.1", port: 0 });
  // Any SDK telemetry/model request from this process fails the test. Child workers use the local provider.
  const localFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
    const host = new URL(
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    ).hostname;
    if (host !== "127.0.0.1")
      throw new Error("Unexpected external request: " + host);
    return localFetch(url, options);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server.app.close();
  await provider.app.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("real OpenAI Agents SDK function tool, no model or API key", () => {
  it("persists intent, requires human approval, and returns a cached receipt on resume", async () => {
    const tool = factory();
    expect(tool.parameters.properties).not.toHaveProperty("token");
    expect(tool.parameters.properties).not.toHaveProperty("intentId");
    const pending = await invoke(tool);
    expect(pending.status).toBe("PENDING_APPROVAL");
    expect(provider.store.snapshot().paymentCount).toBe(0);
    await decide(pending.actionId);
    const first = await invoke(tool);
    expect(first.amountCents).toBe(1000);
    expect(await invoke(factory())).toEqual(first);
    expect(provider.store.snapshot()).toMatchObject({
      paymentCount: 1,
      requestCount: 1,
    });
  });
  it("recovers a real child crash using the same host-owned intent", async () => {
    const pending = await invoke();
    await decide(pending.actionId);
    const crashed = await server.app.inject({
      method: "POST",
      url: "/api/actions/" + pending.actionId + "/execute",
      headers,
      payload: { simulateCrash: true },
    });
    expect(crashed.json().action.status).toBe("UNKNOWN");
    const receipt = await invoke(factory());
    expect(receipt.amountCents).toBe(1000);
    expect(provider.store.snapshot()).toMatchObject({
      paymentCount: 1,
      requestCount: 2,
      deduplicated: 1,
    });
  });
  it("preserves rejection across API restart and a fresh SDK tool", async () => {
    const pending = await invoke();
    await decide(pending.actionId, "reject");
    const providerUrl = provider.app.listeningOrigin;
    await server.app.close();
    server = await buildServer({
      file: join(dir, "ledger.sqlite"),
      apiToken: token,
      providerToken: "sdk-provider-token",
      providerUrl,
    });
    baseUrl = await server.app.listen({ host: "127.0.0.1", port: 0 });
    expect(await invoke(factory())).toMatchObject({
      status: "REJECTED",
      actionId: pending.actionId,
    });
    expect(provider.store.snapshot().paymentCount).toBe(0);
  });
  it("raises immutable-payload conflicts instead of returning apparent tool success", async () => {
    await invoke();
    await expect(
      invoke(factory(), { ...input, amountCents: 2000 }),
    ).rejects.toThrow("different payload");
    expect(server.ledger.snapshot().actions).toHaveLength(1);
    expect(provider.store.snapshot().paymentCount).toBe(0);
  });
  it("rejects model-supplied retry keys and invalid amounts before creating intent", async () => {
    await expect(
      invoke(factory(), { ...input, idempotencyKey: "bypass-key" }),
    ).rejects.toThrow();
    await expect(
      invoke(factory(), { ...input, amountCents: 1.5 }),
    ).rejects.toThrow();
    expect(server.ledger.snapshot().actions).toHaveLength(0);
  });
  it("does not create duplicate effects from overlapping SDK invocations", async () => {
    const pending = await invoke();
    await decide(pending.actionId);
    const results = await Promise.allSettled([
      invoke(factory()),
      invoke(factory()),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(provider.store.snapshot().paymentCount).toBe(1);
    expect(server.ledger.get(pending.actionId).attempts).toBe(1);
  });
});
