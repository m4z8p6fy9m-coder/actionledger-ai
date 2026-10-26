import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export const jsonSchema = z.json();
export function canonical(value: Json): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const intentSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
    connector: z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/),
    operation: z.string().min(1).max(100),
    input: jsonSchema,
    signature: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    causal: z
      .object({
        promptHash: z.string().regex(/^[a-f0-9]{64}$/),
        stateVector: jsonSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type Intent = z.infer<typeof intentSchema>;
/** Versioned, provider-independent identity; the host must persist the same causal state. */
export function causalFingerprint(intent: Intent): string {
  if (!intent.causal) throw new RuntimeError("CAUSAL_STATE_REQUIRED");
  return digest(
    canonical({
      version: 1,
      intentId: intent.id,
      promptHash: intent.causal.promptHash,
      stateVector: intent.causal.stateVector,
    }),
  );
}
export function signIntent(intent: Intent, secret: string): string {
  if (Buffer.byteLength(secret) < 32)
    throw new RuntimeError("SIGNING_KEY_TOO_SHORT");
  const payload = { ...intent };
  delete payload.signature;
  return createHmac("sha256", secret)
    .update(canonical(jsonSchema.parse(payload)))
    .digest("hex");
}
export function verifyIntent(intent: Intent, secret: string): boolean {
  if (!intent.signature) return false;
  const expected = Buffer.from(signIntent(intent, secret), "hex");
  const actual = Buffer.from(intent.signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export type RuntimeStatus =
  | "PENDING_APPROVAL"
  | "READY"
  | "RUNNING"
  | "UNKNOWN"
  | "SUCCEEDED"
  | "REJECTED";
export type RecordRow = {
  id: string;
  connector: string;
  operation: string;
  input: string;
  fingerprint: string;
  provider_key: string;
  binding: string;
  status: RuntimeStatus;
  approval: string | null;
  actor: string | null;
  reason: string | null;
  owner: string | null;
  fence: number;
  lease_until: number;
  attempts: number;
  reference: string | null;
  result: string | null;
  error: string | null;
  next_check: number;
  checks: number;
  created_at: number;
  updated_at: number;
};
export type Evidence =
  | { kind: "succeeded"; reference: string; result: Json }
  | { kind: "rejected"; reference: string | null; code: string }
  | { kind: "unknown"; reference?: string; code: string };
export type ConnectorContext = {
  intent: Intent;
  key: string;
  fingerprint: string;
  reference: string | null;
  signal: AbortSignal;
  bindReference(reference: string): Promise<void>;
};
export interface Connector {
  readonly id: string;
  /** Immutable identity: include account, endpoint, schema and policy, never a credential. */
  readonly binding: string;
  key(intentId: string): string;
  parse(operation: string, input: Json): Json;
  execute(context: ConnectorContext): Promise<Evidence>;
  /** Read only. Never create, confirm, retry or cancel an external effect here. */
  reconcile(context: ConnectorContext): Promise<Evidence>;
}
export class RuntimeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const evidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("succeeded"),
      reference: z.string().min(1).max(256),
      result: jsonSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected"),
      reference: z.string().min(1).max(256).nullable(),
      code: z.string().regex(/^[A-Z0-9_.:-]{1,120}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reference: z.string().min(1).max(256).optional(),
      code: z.string().regex(/^[A-Z0-9_.:-]{1,120}$/),
    })
    .strict(),
]);
export function evidence(raw: unknown): Evidence {
  const parsed = evidenceSchema.parse(raw);
  if (
    parsed.kind === "succeeded" &&
    Buffer.byteLength(canonical(parsed.result)) > 262144
  )
    throw new RuntimeError("RESULT_TOO_LARGE");
  return parsed;
}
