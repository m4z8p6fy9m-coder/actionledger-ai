import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRuntime } from "./config.js";
import { createGateway } from "./mcp.js";
import { createRuntimeHttp } from "./http.js";
const args = process.argv.slice(2);
const transport = args[0] ?? "stdio";
if (!["stdio", "http"].includes(transport) || args.length > 1)
  throw new Error("Usage: pnpm runtime [stdio|http]");
const runtime = await loadRuntime();
runtime.loop.start();
let shutdown = async () => {
  await runtime.close();
};
try {
  if (transport === "stdio") {
    const server = createGateway(
      runtime.engine,
      runtime.intentIds,
      runtime.multiAgentBindings,
    );
    const stdio = new StdioServerTransport();
    const previous = server.server.onclose;
    server.server.onclose = () => {
      previous?.();
      void runtime.close().catch(() => {
        process.exitCode = 1;
      });
    };
    await server.connect(stdio);
    shutdown = async () => {
      await server.close();
      await runtime.close();
    };
  } else {
    const app = createRuntimeHttp(runtime.engine, runtime.loop, {
      operatorToken: process.env.RUNTIME_OPERATOR_TOKEN ?? "",
      agentToken: process.env.RUNTIME_AGENT_TOKEN ?? "",
      intentIds: runtime.intentIds,
      stripe: runtime.stripe,
    });
    const port = Number(process.env.RUNTIME_PORT ?? 4312);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid RUNTIME_PORT");
    await app.listen({ host: process.env.RUNTIME_BIND ?? "127.0.0.1", port });
    shutdown = async () => {
      await app.close();
      await runtime.close();
    };
  }
} catch (error) {
  await runtime.close();
  throw error;
}
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
