import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ActionStore } from "../src/store.js";
import { SqliteDriver } from "../src/driver.js";
import { SimulatedConnector } from "../src/simulated.js";
import { buildProvider } from "../../../apps/provider/src/app.js";
it("survives an MCP server process crash and autonomously restores the result on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-process-regression-"));
  const token = "p".repeat(40);
  const provider = buildProvider(join(dir, "provider.sqlite"), token);
  const url = await provider.app.listen({ host: "127.0.0.1", port: 0 });
  const file = join(dir, "ledger.sqlite");
  const driver = new SqliteDriver(file);
  const store = new ActionStore(driver);
  await store.initialize();
  const intent = {
    id: "stdio-invoice",
    connector: "simulated",
    operation: "payment.create",
    input: { recipient: "Alice", amountCents: 1000 },
  };
  await store.register(
    intent,
    new SimulatedConnector(url, token, "stdio-regression"),
  );
  await store.decide(intent.id, "approve", "Operator", "Reviewed fixture");
  const manifest = join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      namespace: "stdio-regression",
      simulated: { url },
      intents: [intent],
    }),
  );
  const clients: Client[] = [];
  const connect = async (script: string, args: string[]) => {
    const client = new Client({ name: "actual-host", version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", script, ...args],
      env: {
        ...getDefaultEnvironment(),
        ACTIONLEDGER_MANIFEST: manifest,
        RUNTIME_DB: file,
        PROVIDER_TOKEN: token,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    return client;
  };
  try {
    const crashed = await connect(
      fileURLToPath(new URL("./fixtures/mcp-crash.ts", import.meta.url)),
      [file, url, intent.id],
    );
    await expect(
      crashed.callTool({
        name: "actionledger_invoke",
        arguments: { intentId: intent.id },
      }),
    ).rejects.toThrow();
    expect(provider.store.snapshot().paymentCount).toBe(1);
    expect((await store.get(intent.id)).status).toBe("RUNNING");
    await driver.query("UPDATE runtime_actions SET lease_until=0");
    const resumed = await connect(
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      ["stdio"],
    );
    let status: unknown;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await resumed.callTool({
        name: "actionledger_status",
        arguments: { intentId: intent.id },
      });
      status = result.structuredContent;
      if (
        status &&
        typeof status === "object" &&
        "status" in status &&
        status.status === "SUCCEEDED"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(status).toMatchObject({ status: "SUCCEEDED" });
    await resumed.callTool({
      name: "actionledger_invoke",
      arguments: { intentId: intent.id },
    });
    expect(provider.store.snapshot().paymentCount).toBe(1);
    expect(provider.store.snapshot().requestCount).toBe(1);
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await driver.close();
    await provider.app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 20000);
