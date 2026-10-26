import { z } from "zod";
import { createHash } from "node:crypto";

export const LAB_CASES = [
  "protected-crash",
  "unprotected-crash",
  "lost-response",
  "provider-error",
  "approval-gate",
  "payload-conflict",
  "concurrent-workers",
  "unsafe-baseline",
] as const;
export const LabInput = z
  .object({ seed: z.number().int().min(1).max(2147483647) })
  .strict();
export const LabCheck = z
  .object({
    name: z.string().min(1).max(160),
    expected: z.string().max(300),
    actual: z.string().max(300),
    pass: z.boolean(),
  })
  .strict();
export const LabTrace = z
  .object({
    phase: z.string().max(120),
    status: z.string().max(30),
    attempts: z.number().int().nonnegative(),
    payments: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    receiptId: z.string().nullable(),
  })
  .strict();
export const LabCase = z
  .object({
    id: z.enum(LAB_CASES),
    label: z.string().max(160),
    mode: z.enum(["idempotent", "unprotected"]),
    durationMs: z.number().int().nonnegative(),
    checks: z.array(LabCheck).min(1).max(20),
    trace: z.array(LabTrace).min(1).max(20),
    paymentIds: z.array(z.string()).max(10),
    payload: z.object({
      recipient: z.string(),
      amountCents: z.number().int().positive(),
      idempotencyKey: z.string(),
    }),
    approval: z.object({ decision: z.string(), actor: z.string() }).nullable(),
  })
  .strict();
export const LabEvidence = z
  .object({
    formatVersion: z.literal(1),
    suiteVersion: z.literal("1"),
    seed: z.number().int().min(1).max(2147483647),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    runtime: z.object({
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
    cases: z.array(LabCase).length(LAB_CASES.length),
  })
  .strict();
export type LabCaseResult = z.infer<typeof LabCase>;
export type LabEvidenceData = z.infer<typeof LabEvidence>;
export type EvidenceEnvelope = { evidence: LabEvidenceData; sha256: string };
export type LabRun = {
  id: string;
  seed: number;
  status: "RUNNING" | "PASSED" | "FAILED" | "INTERRUPTED";
  createdAt: string;
  finishedAt: string | null;
  completed: number;
  total: number;
  cases: LabCaseResult[];
  error: string | null;
  report: EvidenceEnvelope | null;
};
export function evidenceDigest(evidence: LabEvidenceData) {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
export function verifyEvidence(raw: unknown): EvidenceEnvelope {
  const envelope = z
    .object({
      evidence: LabEvidence,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(raw);
  if (evidenceDigest(envelope.evidence) !== envelope.sha256)
    throw new Error("Evidence fingerprint mismatch");
  const ids = new Set(envelope.evidence.cases.map((c) => c.id));
  if (ids.size !== LAB_CASES.length)
    throw new Error("Evidence must cover every scenario exactly once");
  for (const scenario of envelope.evidence.cases)
    for (const check of scenario.checks) {
      if (check.pass !== (check.expected === check.actual))
        throw new Error("Inconsistent check verdict");
    }
  return envelope;
}
