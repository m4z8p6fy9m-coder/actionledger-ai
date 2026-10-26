export type Status =
  | "PENDING_APPROVAL"
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "REJECTED"
  | "UNKNOWN";
export type Payment = {
  idempotencyKey: string;
  recipient: string;
  amountCents: number;
  currency: "EUR";
  providerMode: "idempotent" | "unprotected";
  description: string;
};
export type Action = {
  id: string;
  idempotency_key: string;
  payload: string;
  status: Status;
  risk: "HIGH";
  attempts: number;
  lease_until: number | null;
  receipt: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
export type Audit = {
  seq: number;
  action_id: string | null;
  event: string;
  detail: string;
  created_at: string;
};
export type Receipt = {
  id: string;
  recipient: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  logicalKey: string;
  protected: boolean;
};
export type Snapshot = {
  actions: Action[];
  counts: { status: Status; count: number }[];
  duplicates: number;
  attempts: number;
  audit: Audit[];
  provider: {
    payments: Receipt[];
    paymentCount: number;
    totalCents: number;
    requestCount: number;
    deduplicated: number;
  } | null;
  providerError: string | null;
  policy: {
    leaseMs: number;
    maxAttempts: number;
    paymentApproval: string;
    automaticRetry: boolean;
  };
};
export type Detail = {
  action: Action;
  approval: {
    decision: string;
    actor: string;
    reason: string;
    created_at: string;
  } | null;
  attempts: {
    number: number;
    outcome: string;
    started_at: string;
    finished_at: string | null;
  }[];
  audit: Audit[];
};
export { ApiError } from "./lib/api-client";
import { createApiClient } from "./lib/api-client";
export const api = createApiClient();
export type ActionPage = {
  items: Action[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};
export const money = (cents: number) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(
    cents / 100,
  );
export const payload = (a: Action) => JSON.parse(a.payload) as Payment;
export const time = (date: string) =>
  new Date(date).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export const labels: Record<Status, string> = {
  PENDING_APPROVAL: "Awaiting approval",
  READY: "Ready to execute",
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  REJECTED: "Rejected",
  UNKNOWN: "Unknown outcome",
};
