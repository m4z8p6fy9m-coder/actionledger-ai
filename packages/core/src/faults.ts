import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Ledger, PaymentProvider, DomainError, type Payment } from "./index.js";

export const FaultCommand = z
  .object({
    op: z.enum([
      "create",
      "approve",
      "reject",
      "duplicate",
      "mutate",
      "execute",
      "recover",
      "restart",
    ]),
    intent: z.enum(["alpha", "beta", "gamma"]).default("alpha"),
    fault: z
      .enum([
        "none",
        "before-dispatch",
        "after-provider-commit",
        "before-checkpoint",
      ])
      .default("none"),
  })
  .strict();
export const FaultRecipe = z
  .object({
    formatVersion: z.literal(1),
    target: z.enum(["actionledger", "unsafe-baseline"]),
    providerMode: z.enum(["idempotent", "unprotected"]),
    commands: z.array(FaultCommand).max(160),
  })
  .strict();
export type FaultRecipeData = z.infer<typeof FaultRecipe>;
export type FaultCommandData = z.infer<typeof FaultCommand>;
export type FaultStep = {
  index: number;
  command: FaultCommandData;
  outcome: string;
  status: string;
  requests: number;
  payments: number;
};
export type FaultReplay = {
  signature: string | null;
  trace: FaultStep[];
  payments: number;
  requests: number;
};
export type FaultReduction = {
  signature: string;
  original: FaultRecipeData;
  minimal: FaultRecipeData;
  attempts: number;
  budgetExhausted: boolean;
  oneMinimal: boolean;
  replay: FaultReplay;
};
const fixturePayment = (
  intent: string,
  mode: Payment["providerMode"],
): Payment => ({
  idempotencyKey: "finder.invoice." + intent,
  recipient: "Synthetic " + intent,
  amountCents: 1000,
  currency: "EUR",
  providerMode: mode,
  description: "Isolated fault-finder fixture",
});

/** Real core + independent persistent SQLite stores. Faults are injected exceptions, not OS kills. */
export async function replayFaultCase(raw: unknown): Promise<FaultReplay> {
  const recipe = FaultRecipe.parse(raw);
  const dir = mkdtempSync(join(tmpdir(), "actionledger-finder-"));
  const ledgerFile = join(dir, "ledger.sqlite");
  const providerFile = join(dir, "provider.sqlite");
  let ledger = new Ledger(ledgerFile);
  let provider = new PaymentProvider(providerFile);
  const initialize = () =>
    ledger.db.exec(
      "CREATE TABLE IF NOT EXISTS unsafe_fixture_checkpoints(logical_key TEXT PRIMARY KEY,receipt TEXT NOT NULL)",
    );
  initialize();
  const trace: FaultStep[] = [];
  let signature: string | null = null;
  const lookup = (intent: string) =>
    ledger.db
      .prepare("SELECT id FROM actions WHERE idempotency_key=?")
      .get(fixturePayment(intent, recipe.providerMode).idempotencyKey)?.id;
  try {
    for (const [index, command] of recipe.commands.entries()) {
      const existing = lookup(command.intent);
      const before = existing ? ledger.get(String(existing)) : null;
      const requestCount = provider.snapshot().requestCount;
      let outcome = "OK";
      try {
        if (command.op === "restart") {
          ledger.close();
          provider.close();
          ledger = new Ledger(ledgerFile);
          provider = new PaymentProvider(providerFile);
          initialize();
        } else if (command.op === "create" || command.op === "duplicate")
          ledger.create(fixturePayment(command.intent, recipe.providerMode));
        else if (command.op === "mutate")
          ledger.create({
            ...fixturePayment(command.intent, recipe.providerMode),
            amountCents: 2000,
          });
        else {
          const row = lookup(command.intent);
          if (!row)
            throw new DomainError("NOT_FOUND", "Intent does not exist", 404);
          const id = String(row);
          if (command.op === "approve" || command.op === "reject")
            ledger.decide(
              id,
              command.op === "approve" ? "approve" : "reject",
              "Finder fixture (synthetic)",
              "Explicit isolated fixture decision",
            );
          else if (recipe.target === "unsafe-baseline") {
            // Positive control only: approval + local success cache, with no uncertainty guard.
            if (ledger.detail(id).approval?.decision !== "approve")
              throw new DomainError(
                "APPROVAL_REQUIRED",
                "Fixture approval missing",
              );
            const payment = JSON.parse(ledger.get(id).payload) as Payment;
            const cached = ledger.db
              .prepare(
                "SELECT receipt FROM unsafe_fixture_checkpoints WHERE logical_key=?",
              )
              .get(payment.idempotencyKey);
            if (!cached) {
              if (command.fault === "before-dispatch")
                throw new Error("INJECTED_BEFORE_DISPATCH");
              const receipt = provider.charge(payment);
              if (command.fault !== "none")
                throw new Error("INJECTED_AFTER_EXTERNAL_COMMIT");
              ledger.db
                .prepare("INSERT INTO unsafe_fixture_checkpoints VALUES(?,?)")
                .run(payment.idempotencyKey, JSON.stringify(receipt));
            }
          } else {
            await ledger.execute(
              id,
              async (payment) => {
                if (command.fault === "before-dispatch")
                  throw new Error("INJECTED_BEFORE_DISPATCH");
                const receipt = provider.charge(payment);
                if (command.fault === "after-provider-commit")
                  throw new Error("INJECTED_AFTER_EXTERNAL_COMMIT");
                return receipt;
              },
              {
                recovery: command.op === "recover",
                afterCommit: () => {
                  if (command.fault === "before-checkpoint")
                    throw new Error("INJECTED_BEFORE_CHECKPOINT");
                },
              },
            );
          }
        }
      } catch (error) {
        if (error instanceof DomainError) outcome = error.code;
        else if (
          error instanceof Error &&
          [
            "INJECTED_BEFORE_DISPATCH",
            "INJECTED_AFTER_EXTERNAL_COMMIT",
            "INJECTED_BEFORE_CHECKPOINT",
          ].includes(error.message)
        )
          outcome = error.message;
        else throw error;
      }
      const state = provider.snapshot();
      const current = lookup(command.intent);
      const after = current ? ledger.get(String(current)) : null;
      trace.push({
        index,
        command,
        outcome,
        status: after?.status ?? "NO_INTENT",
        requests: state.requestCount,
        payments: state.paymentCount,
      });
      for (const intent of ["alpha", "beta", "gamma"]) {
        const key = fixturePayment(intent, recipe.providerMode).idempotencyKey;
        const payments = state.payments.filter((p) => p.logicalKey === key);
        if (payments.length > 1) {
          signature = "DUPLICATE_EXTERNAL_EFFECT:" + intent;
          break;
        }
        const row = lookup(intent);
        if (
          payments.length &&
          (!row || ledger.detail(String(row)).approval?.decision !== "approve")
        ) {
          signature = "UNAPPROVED_EXTERNAL_EFFECT:" + intent;
          break;
        }
      }
      if (
        !signature &&
        recipe.target === "actionledger" &&
        before?.status === "SUCCEEDED" &&
        state.requestCount !== requestCount
      )
        signature = "CACHED_SUCCESS_REDISPATCH:" + command.intent;
      if (
        !signature &&
        recipe.target === "actionledger" &&
        before?.status === "UNKNOWN" &&
        recipe.providerMode === "unprotected" &&
        ["execute", "recover"].includes(command.op) &&
        state.requestCount !== requestCount
      )
        signature = "UNSAFE_UNKNOWN_REPLAY:" + command.intent;
      if (signature) break;
    }
    const state = provider.snapshot();
    return {
      signature,
      trace,
      payments: state.paymentCount,
      requests: state.requestCount,
    };
  } finally {
    ledger.close();
    provider.close();
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

/** ddmin followed by single-removal verification. Never claims global shortestness. */
export async function minimizeFaultCase(
  raw: unknown,
  budget = 128,
): Promise<FaultReduction> {
  const original = FaultRecipe.parse(raw);
  if (!Number.isInteger(budget) || budget < 1 || budget > 512)
    throw new Error("Reduction budget must be 1..512");
  let attempts = 0;
  const test = async (recipe: FaultRecipeData) => {
    attempts++;
    return replayFaultCase(recipe);
  };
  let replay = await test(original);
  const signature = replay.signature;
  if (!signature)
    throw new Error("Cannot reduce a case without an observed violation");
  let commands = [...original.commands];
  let granularity = 2;
  while (commands.length > 1 && attempts < budget) {
    const width = Math.ceil(commands.length / granularity);
    let reduced = false;
    for (
      let start = 0;
      start < commands.length && attempts < budget;
      start += width
    ) {
      const candidate = [
        ...commands.slice(0, start),
        ...commands.slice(start + width),
      ];
      const result = await test({ ...original, commands: candidate });
      if (result.signature === signature) {
        commands = candidate;
        replay = result;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= commands.length) break;
      granularity = Math.min(commands.length, granularity * 2);
    }
  }
  let oneMinimal = false;
  while (attempts < budget) {
    let removed = false;
    let checked = 0;
    for (let index = 0; index < commands.length && attempts < budget; index++) {
      const candidate = commands.filter((_, i) => i !== index);
      const result = await test({ ...original, commands: candidate });
      checked++;
      if (result.signature === signature) {
        commands = candidate;
        replay = result;
        removed = true;
        break;
      }
    }
    if (!removed) {
      oneMinimal = checked === commands.length;
      break;
    }
  }
  return {
    signature,
    original,
    minimal: { ...original, commands },
    attempts,
    budgetExhausted: !oneMinimal && attempts >= budget,
    oneMinimal,
    replay,
  };
}

export const FaultCampaignInput = z
  .object({
    seed: z.number().int().min(1).max(2147483647),
    cases: z.number().int().min(1).max(100).default(24),
    target: z.enum(["actionledger", "unsafe-baseline"]).default("actionledger"),
    providerMode: z.enum(["idempotent", "unprotected"]).default("unprotected"),
    shrinkBudget: z.number().int().min(1).max(512).default(128),
  })
  .strict();
/** Includes known crash-gap templates as calibration, with seeded randomized command noise. */
export async function findFault(raw: unknown) {
  const config = FaultCampaignInput.parse(raw);
  let state = config.seed;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  let executedCases = 0;
  let commandsExecuted = 0;
  for (let n = 0; n < config.cases; n++) {
    const commands: FaultCommandData[] = [];
    const noiseCount = 8 + (random() % 12);
    for (let i = 0; i < noiseCount; i++)
      commands.push(
        FaultCommand.parse({
          op: [
            "create",
            "approve",
            "reject",
            "duplicate",
            "mutate",
            "execute",
            "recover",
            "restart",
          ][random() % 8],
          intent: ["beta", "gamma"][random() % 2],
          fault: [
            "none",
            "before-dispatch",
            "after-provider-commit",
            "before-checkpoint",
          ][random() % 4],
        }),
      );
    const gap = FaultRecipe.parse({
      formatVersion: 1,
      target: config.target,
      providerMode: config.providerMode,
      commands: [
        { op: "create" },
        { op: "approve" },
        {
          op: "execute",
          fault: random() % 2 ? "after-provider-commit" : "before-checkpoint",
        },
        { op: "restart" },
        { op: "recover" },
      ],
    }).commands;
    const position = random() % (commands.length + 1);
    commands.splice(position, 0, ...gap);
    const recipe: FaultRecipeData = {
      formatVersion: 1,
      target: config.target,
      providerMode: config.providerMode,
      commands,
    };
    const replay = await replayFaultCase(recipe);
    executedCases++;
    commandsExecuted += replay.trace.length;
    if (replay.signature) {
      const reduction = await minimizeFaultCase(recipe, config.shrinkBudget);
      return {
        formatVersion: 1,
        config,
        executedCases,
        commandsExecuted,
        verdict: "VIOLATION_FOUND" as const,
        reduction,
      };
    }
  }
  return {
    formatVersion: 1,
    config,
    executedCases,
    commandsExecuted,
    verdict: "NO_VIOLATION_OBSERVED" as const,
    reduction: null,
  };
}
