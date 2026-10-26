import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const names = [
  "POSTGRES_PASSWORD",
  "RUNTIME_OPERATOR_TOKEN",
  "RUNTIME_AGENT_TOKEN",
  "PROVIDER_TOKEN",
];
await writeFile(
  "deploy/.env",
  names.map((name) => name + "=" + randomBytes(32).toString("hex")).join("\n") +
    "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Created deploy/.env with distinct random local credentials. Keep this file private.",
);
