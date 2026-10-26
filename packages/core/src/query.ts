import { z } from "zod";
import type { Action, Payment } from "./index.js";

export const ActionStatus = z.enum([
  "PENDING_APPROVAL",
  "READY",
  "RUNNING",
  "SUCCEEDED",
  "REJECTED",
  "UNKNOWN",
]);
export const ActionQuery = z
  .object({
    q: z.string().trim().max(120).default(""),
    status: ActionStatus.optional(),
    sort: z.enum(["newest", "oldest"]).default("newest"),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    offset: z.coerce.number().int().min(0).max(100000000).default(0),
  })
  .strict();
export const MAX_EXPORT_ACTIONS = 10000;
export type ActionPage = {
  items: Action[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

/** Bound parameters make search literal: %, _, quotes, and SQL fragments are ordinary text. */
export function actionFilterSql(
  query: Pick<z.infer<typeof ActionQuery>, "status" | "q">,
) {
  return {
    where:
      "WHERE (? IS NULL OR status=?) AND (?='' OR instr(lower(id || ' ' || idempotency_key || ' ' || json_extract(payload,'$.recipient') || ' ' || json_extract(payload,'$.description')),lower(?))>0)",
    params: [query.status ?? null, query.status ?? null, query.q, query.q],
  };
}
function csvCell(value: string | number) {
  const text = String(value);
  const safe = /^[\t\r\n]|^\s*[=+\-@]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}
export function actionsToCsv(actions: Action[]): string {
  const rows: (string | number)[][] = [
    [
      "id",
      "key",
      "recipient",
      "amount_cents",
      "currency",
      "provider_mode",
      "status",
      "attempts",
      "created_at",
    ],
  ];
  for (const action of actions) {
    const payment = JSON.parse(action.payload) as Payment;
    rows.push([
      action.id,
      action.idempotency_key,
      payment.recipient,
      payment.amountCents,
      payment.currency,
      payment.providerMode,
      action.status,
      action.attempts,
      action.created_at,
    ]);
  }
  return (
    "\uFEFF" +
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
