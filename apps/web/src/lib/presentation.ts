import type { Action, Snapshot } from "../api";

export type ExecutionResult = {
  action: Action;
  crashed: boolean;
  cached: boolean;
};

/** A failed follow-up read must not make a completed mutation look unsent. */
export async function readDetailAfterMutation<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch {
    throw new Error(
      "The request completed, but action details could not be refreshed. Inspect the ledger before taking further action.",
    );
  }
}

/** Messages must describe the returned durable state, including cached results. */
export function executionMessage(result: ExecutionResult, recovery: boolean) {
  if (result.cached)
    return "A previously recorded result was returned; no new payment was dispatched.";
  if (result.crashed && result.action.status === "UNKNOWN")
    return "The worker exited before its checkpoint. The ledger outcome is UNKNOWN; inspect provider evidence.";
  if (result.action.status === "SUCCEEDED")
    return recovery
      ? "Recovery recorded the result using the original provider key."
      : "The simulated payment result was recorded.";
  return "The action did not reach a recorded success. Inspect its ledger state before retrying.";
}

/** Provider snapshots contain only the latest 200 receipts, not full history. */
export function recentProviderEvidence(
  provider: Snapshot["provider"],
  action: Action | null,
) {
  if (!provider)
    return {
      count: null,
      empty:
        "The simulated provider is unavailable. Reconnect before inspecting receipts.",
    };
  if (!action)
    return {
      count: 0,
      empty: "Create a scenario to inspect its simulated provider receipts.",
    };
  const count = provider.payments.filter(
    (receipt) => receipt.logicalKey === action.idempotency_key,
  ).length;
  return {
    count,
    empty:
      "No matching receipt in the latest 200 provider payments. This does not prove no payment occurred.",
  };
}
