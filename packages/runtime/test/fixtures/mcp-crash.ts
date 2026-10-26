import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ActionStore } from "../../src/store.js";
import { SqliteDriver } from "../../src/driver.js";
import { ActionEngine } from "../../src/engine.js";
import { createGateway } from "../../src/mcp.js";
import { SimulatedConnector } from "../../src/simulated.js";
const [file, url, id] = process.argv.slice(2);
const store = new ActionStore(new SqliteDriver(file));
await store.initialize();
const connector = new SimulatedConnector(
  url,
  process.env.PROVIDER_TOKEN!,
  "stdio-regression",
);
const dispatch = connector.execute.bind(connector);
connector.execute = async (context) => {
  await dispatch(context);
  process.exit(86);
};
const server = createGateway(new ActionEngine(store, [connector]), [id]);
await server.connect(new StdioServerTransport());
