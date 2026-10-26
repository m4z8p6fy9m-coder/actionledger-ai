import { writeFile } from "node:fs/promises";
import { runLaboratory } from "../apps/server/src/lab-runner.ts";
const args = process.argv.slice(2);
const seedIndex = args.indexOf("--seed");
const outputIndex = args.indexOf("--output");
const seed = seedIndex < 0 ? 5409 : Number(args[seedIndex + 1]);
const report = await runLaboratory(seed, (result) =>
  console.log(
    (result.checks.every((c) => c.pass) ? "PASS " : "FAIL ") +
      result.id +
      " / " +
      result.checks.length +
      " checks / " +
      result.durationMs +
      "ms",
  ),
);
if (outputIndex >= 0) {
  const target = args[outputIndex + 1];
  if (!target) throw new Error("--output needs a file path");
  await writeFile(target, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  console.log("Evidence written: " + target);
}
console.log("SHA-256 " + report.sha256);
console.log(
  "Evidence is an observed simulator run, not a formal proof or signature.",
);
if (report.evidence.cases.some((c) => c.checks.some((k) => !k.pass)))
  process.exitCode = 1;
