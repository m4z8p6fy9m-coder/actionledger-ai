import { readFile } from "node:fs/promises";
import { verifyEvidence } from "../packages/core/dist/evidence.js";
const file = process.argv[2];
if (!file) throw new Error("Usage: pnpm evidence:verify path/to/evidence.json");
const report = verifyEvidence(JSON.parse(await readFile(file, "utf8")));
const checks = report.evidence.cases.flatMap((c) => c.checks);
console.log("Fingerprint and report consistency verified: " + report.sha256);
console.log(
  checks.filter((c) => c.pass).length +
    "/" +
    checks.length +
    " checks passed across " +
    report.evidence.cases.length +
    " scenarios; seed " +
    report.evidence.seed,
);
console.log(
  "A fingerprint detects edits; it does not authenticate the author or prove safety.",
);
if (checks.some((c) => !c.pass)) process.exitCode = 1;
