/** Offline-capable adapter. No OpenAI package or key is needed here. */
export function makeLedgerPayment({
  baseUrl = "http://127.0.0.1:4310",
  token,
  intentId,
}) {
  if (!token || !intentId)
    throw new Error(
      "A local token and durable application-owned intentId are required",
    );
  async function request(route, body) {
    const response = await fetch(baseUrl + "/api" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? data.error);
    return data;
  }
  return async function pay({ recipient, amountCents }) {
    // The host persists intentId BEFORE running the agent. Never generate a key here.
    const { action } = await request("/actions", {
      idempotencyKey: "agent." + intentId,
      recipient,
      amountCents,
      currency: "EUR",
      providerMode: "idempotent",
      description: "SDK-wrapped payment intent",
    });
    if (action.status === "SUCCEEDED") return JSON.parse(action.receipt);
    if (action.status === "PENDING_APPROVAL")
      return {
        actionId: action.id,
        status: action.status,
        message:
          "A human must approve this exact intent in ActionLedger before resuming.",
      };
    if (action.status === "REJECTED")
      return {
        actionId: action.id,
        status: action.status,
        message:
          "Human rejected this intent. Do not create another key to bypass the decision.",
      };
    const route =
      action.status === "UNKNOWN" || action.status === "RUNNING"
        ? "recover"
        : "execute";
    const result = await request("/actions/" + action.id + "/" + route, {});
    return result.action.receipt
      ? JSON.parse(result.action.receipt)
      : { actionId: action.id, status: result.action.status };
  };
}
