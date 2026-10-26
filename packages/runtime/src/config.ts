import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Stripe from "stripe";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  intentSchema,
  canonical,
  digest,
  jsonSchema,
  verifyIntent,
  type Connector,
} from "./contracts.js";
import { SqliteDriver, PostgresDriver } from "./driver.js";
import { ActionStore } from "./store.js";
import { ActionEngine, RecoveryLoop } from "./engine.js";
import { StripeConnector } from "./stripe.js";
import { SimulatedConnector } from "./simulated.js";
import { RestConnector } from "./rest.js";
import { McpToolConnector } from "./mcp.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
const schema = z
  .object({
    namespace: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
    intents: z.array(intentSchema).min(1).max(1000),
    multiAgent: z
      .object({
        windowMs: z.number().int().min(0).max(86400000).default(1000),
        bindings: z
          .array(
            z
              .object({
                intentId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
                agentId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
                promptHash: z.string().regex(/^[a-f0-9]{64}$/),
                assetId: z.string().min(1).max(256),
              })
              .strict(),
          )
          .min(1)
          .max(1000),
      })
      .strict()
      .optional(),
    simulated: z.object({ url: z.url() }).strict().optional(),
    stripe: z
      .object({
        liveMode: z.boolean().default(false),
        account: z.string().optional(),
      })
      .strict()
      .optional(),
    rest: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/),
            url: z.url(),
            tokenEnv: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]*$/)
              .optional(),
            operation: z.string().min(1).max(100),
            inputSchema: z.record(z.string(), jsonSchema),
            finalitySchema: z.record(z.string(), jsonSchema).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    upstreams: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/),
            url: z.url(),
            tokenEnv: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]*$/)
              .optional(),
            tools: z.record(z.string(), z.record(z.string(), jsonSchema)),
            finalitySchemas: z
              .record(z.string(), z.record(z.string(), jsonSchema))
              .default({}),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export async function loadRuntime(env: NodeJS.ProcessEnv = process.env) {
  const raw = await readFile(
    resolve(env.ACTIONLEDGER_MANIFEST ?? "config/runtime.example.json"),
    "utf8",
  );
  if (Buffer.byteLength(raw) > 1048576)
    throw new Error("Manifest exceeds 1 MiB");
  const manifest = schema.parse(JSON.parse(raw));
  if (
    new Set(manifest.intents.map((i) => i.id)).size !== manifest.intents.length
  )
    throw new Error("Duplicate host intent ID");
  let multiAgentBindings:
    Record<string, { agentId: string; semanticHash: string }> | undefined;
  if (manifest.multiAgent) {
    multiAgentBindings = {};
    for (const binding of manifest.multiAgent.bindings) {
      if (
        Object.hasOwn(multiAgentBindings, binding.intentId) ||
        !manifest.intents.some((intent) => intent.id === binding.intentId)
      )
        throw new Error("Invalid multi-agent binding");
      multiAgentBindings[binding.intentId] = {
        agentId: binding.agentId,
        semanticHash: digest(
          canonical({
            version: 1,
            promptHash: binding.promptHash,
            assetId: binding.assetId,
          }),
        ),
      };
    }
    if (Object.keys(multiAgentBindings).length !== manifest.intents.length)
      throw new Error("Bind every host intent to a multi-agent identity");
  }
  for (const intent of manifest.intents) {
    if (intent.causal || intent.signature) {
      const secret = env.ACTIONLEDGER_SIGNING_KEY ?? "";
      if (!verifyIntent(intent, secret))
        throw new Error("Host intent signature invalid or missing");
    }
  }
  const driver = env.DATABASE_URL
    ? new PostgresDriver(env.DATABASE_URL)
    : new SqliteDriver(resolve(env.RUNTIME_DB ?? "data/runtime.sqlite"));
  const clients: Client[] = [];
  try {
    const store = new ActionStore(driver);
    await store.initialize();
    const connectors: Connector[] = [];
    let stripe: StripeConnector | undefined;
    if (manifest.stripe) {
      const key = env.STRIPE_SECRET_KEY ?? "";
      const expected = manifest.stripe.liveMode ? "sk_live_" : "sk_test_";
      if (!key.startsWith(expected))
        throw new Error(
          "Stripe credential must match explicit liveMode policy",
        );
      stripe = new StripeConnector(
        new Stripe(key, {
          httpClient: Stripe.createFetchHttpClient(),
          apiVersion: Stripe.API_VERSION,
          maxNetworkRetries: 0,
          timeout: 8000,
        }),
        {
          namespace: manifest.namespace,
          ...manifest.stripe,
          webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
        },
      );
      connectors.push(stripe);
    }
    if (manifest.simulated) {
      if (!env.PROVIDER_TOKEN || env.PROVIDER_TOKEN.length < 32)
        throw new Error("PROVIDER_TOKEN must have 32+ characters");
      connectors.push(
        new SimulatedConnector(
          manifest.simulated.url,
          env.PROVIDER_TOKEN,
          manifest.namespace,
        ),
      );
    }
    for (const rest of manifest.rest) {
      const token = rest.tokenEnv ? env[rest.tokenEnv] : undefined;
      if (rest.tokenEnv && !token) throw new Error("REST credential missing");
      connectors.push(
        new RestConnector(
          rest.id,
          rest.url,
          token,
          manifest.namespace,
          rest.operation,
          rest.inputSchema as JsonSchemaType,
          rest.finalitySchema as JsonSchemaType | undefined,
        ),
      );
    }
    for (const upstream of manifest.upstreams) {
      const url = new URL(upstream.url);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
          ))
      )
        throw new Error(
          "Use HTTPS upstreams or loopback HTTP, without embedded credentials",
        );
      const token = upstream.tokenEnv ? env[upstream.tokenEnv] : undefined;
      if (upstream.tokenEnv && !token)
        throw new Error("Upstream credential missing");
      const client = new Client({
        name: "actionledger-upstream",
        version: "0.6.0",
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: token ? { authorization: "Bearer " + token } : {},
          },
        }),
      );
      connectors.push(
        new McpToolConnector(
          upstream.id,
          client,
          manifest.namespace + "\0" + url.href,
          upstream.tools as Record<string, JsonSchemaType>,
          upstream.finalitySchemas as Record<string, JsonSchemaType>,
        ),
      );
    }
    const engine = new ActionEngine(store, connectors, {
      multiAgentWindowMs: manifest.multiAgent?.windowMs,
    });
    for (const intent of manifest.intents) await engine.prepare(intent);
    const loop = new RecoveryLoop(engine);
    let closing: Promise<void> | null = null;
    return {
      engine,
      loop,
      stripe,
      intentIds: manifest.intents.map((i) => i.id),
      multiAgentBindings,
      close: () =>
        (closing ??= (async () => {
          await loop.stop();
          await engine.drain();
          await Promise.all(clients.map((c) => c.close()));
          await driver.close();
        })()),
    };
  } catch (error) {
    await Promise.allSettled(clients.map((c) => c.close()));
    await driver.close();
    throw error;
  }
}
