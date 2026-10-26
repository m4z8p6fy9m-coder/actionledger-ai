import { describe, expect, it } from "vitest";
import {
  FaultRecipe,
  replayFaultCase,
  minimizeFaultCase,
  findFault,
} from "@actionledger/core";
const recipe = (target = "actionledger", providerMode = "unprotected") =>
  FaultRecipe.parse({
    formatVersion: 1,
    target,
    providerMode,
    commands: [
      { op: "create" },
      { op: "approve" },
      { op: "execute", fault: "after-provider-commit" },
      { op: "restart" },
      { op: "recover" },
    ],
  });
describe("reproducible fault finding", () => {
  it("detects duplicate effects in the deliberately unsafe positive control", async () => {
    const result = await replayFaultCase(recipe("unsafe-baseline"));
    expect(result.signature).toBe("DUPLICATE_EXTERNAL_EFFECT:alpha");
    expect(result.payments).toBe(2);
  });
  it.each(["unprotected", "idempotent"])(
    "survives crash-gap replay with %s provider",
    async (mode) => {
      const result = await replayFaultCase(recipe("actionledger", mode));
      expect(result.signature).toBeNull();
      expect(result.payments).toBe(1);
      expect(result.trace.at(-1)?.status).toBe(
        mode === "unprotected" ? "UNKNOWN" : "SUCCEEDED",
      );
      expect(result.requests).toBe(mode === "unprotected" ? 1 : 2);
    },
  );
  it("retains a human veto across restart", async () => {
    const input = recipe();
    input.commands[1].op = "reject";
    const result = await replayFaultCase(input);
    expect(result.payments).toBe(0);
    expect(result.trace.at(-1)?.status).toBe("REJECTED");
  });
  it("reduces the same failure and verifies every single-command removal", async () => {
    const reduction = await minimizeFaultCase(recipe("unsafe-baseline"));
    expect(reduction.oneMinimal).toBe(true);
    expect(reduction.minimal.commands).toHaveLength(4);
    expect(reduction.replay.signature).toBe(reduction.signature);
    for (let i = 0; i < reduction.minimal.commands.length; i++) {
      const result = await replayFaultCase({
        ...reduction.minimal,
        commands: reduction.minimal.commands.filter((_, j) => i !== j),
      });
      expect(result.signature).not.toBe(reduction.signature);
    }
  });
  it("does not claim minimality when its replay budget is exhausted", async () => {
    const reduction = await minimizeFaultCase(recipe("unsafe-baseline"), 1);
    expect(reduction.oneMinimal).toBe(false);
    expect(reduction.budgetExhausted).toBe(true);
  });
  it("refuses to shrink a passing recipe", async () => {
    await expect(minimizeFaultCase(recipe())).rejects.toThrow(
      "without an observed violation",
    );
  });
  it("reproduces seeded positive controls", async () => {
    const first = await findFault({
      seed: 5409,
      target: "unsafe-baseline",
      cases: 2,
    });
    const second = await findFault({
      seed: 5409,
      target: "unsafe-baseline",
      cases: 2,
    });
    expect(first).toEqual(second);
    expect(first.reduction?.oneMinimal).toBe(true);
  });
  it.each(["idempotent", "unprotected"])(
    "checks bounded guarded campaigns with %s policy",
    async (providerMode) => {
      const report = await findFault({ seed: 5409, cases: 8, providerMode });
      expect(report.verdict).toBe("NO_VIOLATION_OBSERVED");
      expect(report.executedCases).toBe(8);
    },
  );
  it("rejects arbitrary operations and oversized recipes", () => {
    expect(() =>
      FaultRecipe.parse({ ...recipe(), url: "https://example.com" }),
    ).toThrow();
    expect(() =>
      FaultRecipe.parse({
        ...recipe(),
        commands: Array(161).fill({ op: "create" }),
      }),
    ).toThrow();
  });
});
