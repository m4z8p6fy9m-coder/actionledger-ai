import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Client } from "../packages/runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "../packages/runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const entries = Object.fromEntries(
  (await readFile("deploy/.env", "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const base = "http://127.0.0.1:4312";
const request = async (route, token, body) => {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, "Unexpected runtime HTTP status");
  return response.json();
};
const id = "compose-invoice-001";
assert.equal(
  (await request("/v1/intents/" + id, entries.RUNTIME_AGENT_TOKEN)).status,
  "PENDING_APPROVAL",
);
const client = new Client({ name: "compose-smoke", version: "1" });
try {
  await client.connect(
    new StdioClientTransport({
      command: "docker",
      args: [
        "compose",
        "--env-file",
        "deploy/.env",
        "exec",
        "-T",
        "gateway",
        "node",
        "dist/cli.js",
        "stdio",
      ],
      env: getDefaultEnvironment(),
      stderr: "pipe",
    }),
  );
  let result = await client.callTool({
    name: "actionledger_invoke",
    arguments: { intentId: id },
  });
  assert.equal(result.structuredContent.status, "PENDING_APPROVAL");
  await request(
    "/v1/intents/" + id + "/decision",
    entries.RUNTIME_OPERATOR_TOKEN,
    {
      decision: "approve",
      actor: "CI operator",
      reason: "Reviewed disposable simulated payment",
    },
  );
  result = await client.callTool({
    name: "actionledger_invoke",
    arguments: { intentId: id },
  });
  assert.equal(result.structuredContent.status, "SUCCEEDED");
  result = await client.callTool({
    name: "actionledger_invoke",
    arguments: { intentId: id },
  });
  assert.equal(result.structuredContent.status, "SUCCEEDED");
  const script =
    "fetch('http://127.0.0.1:4311/payments',{headers:{authorization:'Bearer '+process.env.PROVIDER_TOKEN}}).then(r=>r.json()).then(d=>console.log(JSON.stringify({payments:d.paymentCount,requests:d.requestCount})))";
  const counts = JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "--env-file",
        "deploy/.env",
        "exec",
        "-T",
        "provider",
        "node",
        "-e",
        script,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(counts, { payments: 1, requests: 1 });
  console.log(
    "PASS: Compose PostgreSQL, MCP, durable approval and one simulated external payment",
  );
} finally {
  await client.close();
}
