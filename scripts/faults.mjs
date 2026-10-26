import { writeFile, readFile } from "node:fs/promises";
import { findFault, replayFaultCase } from "../packages/core/dist/faults.js";
const args = process.argv.slice(2);
try {
  if (args[0] === "replay") {
    if (args.length !== 2)
      throw new Error("Usage: pnpm faults replay recipe.json");
    const replay = await replayFaultCase(
      JSON.parse(await readFile(args[1], "utf8")),
    );
    console.log(JSON.stringify(replay, null, 2));
    process.exitCode = replay.signature ? 2 : 0;
  } else {
    const options = { seed: 5409 };
    let output;
    let expectViolation = false;
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--expect-violation") {
        expectViolation = true;
        continue;
      }
      const value = args[++i];
      if (!value) throw new Error("Missing value for " + flag);
      if (flag === "--output") output = value;
      else if (flag === "--target") options.target = value;
      else if (flag === "--provider-mode") options.providerMode = value;
      else if (flag === "--seed") options.seed = Number(value);
      else if (flag === "--cases") options.cases = Number(value);
      else if (flag === "--budget") options.shrinkBudget = Number(value);
      else throw new Error("Unknown option: " + flag);
    }
    const report = await findFault(options);
    if (output)
      await writeFile(
        output,
        JSON.stringify(report.reduction?.minimal ?? report, null, 2) + "\n",
        { flag: "wx" },
      );
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = expectViolation
      ? report.reduction
        ? 0
        : 1
      : report.reduction
        ? 2
        : 0;
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Fault campaign failed",
  );
  process.exitCode = 1;
}
