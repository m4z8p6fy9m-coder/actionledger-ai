import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { z } from "zod";
import {
  canonical,
  digest,
  jsonSchema,
  RuntimeError,
  type Connector,
  type ConnectorContext,
  type Evidence,
  type Json,
} from "./contracts.js";
import { ActionEngine } from "./engine.js";
export function createGateway(
  engine: ActionEngine,
  hostIntentIds: readonly string[],
  bindings?: Readonly<
    Record<string, { agentId: string; semanticHash: string }>
  >,
): McpServer {
  const ids = new Set(hostIntentIds);
  if (!ids.size || ids.size > 1000)
    throw new Error("Configure 1..1000 host-owned intents");
  if (
    bindings &&
    (Object.keys(bindings).length !== ids.size ||
      Object.keys(bindings).some((id) => !ids.has(id)))
  )
    throw new Error(
      "Bind every granted intent to a trusted agent identity and semantic hash",
    );
  const server = new McpServer({
    name: "actionledger-gateway",
    version: "0.6.0",
  });
  const inputSchema = z
    .object({
      intentId: z.string().min(1).max(128),
      input: jsonSchema.optional(),
      operation: z.string().optional(),
    })
    .strict();
  const handle = async (
    intentId: string,
    execute: boolean,
    suppliedInput?: Json,
    operation?: string,
  ) => {
    try {
      if (!ids.has(intentId)) throw new RuntimeError("INTENT_NOT_GRANTED");
      const original = await engine.store.get(intentId);
      if (
        execute &&
        ((suppliedInput !== undefined &&
          canonical(suppliedInput) !== original.input) ||
          (operation !== undefined && operation !== original.operation))
      ) {
        await engine.store.freeze(intentId);
        return {
          isError: true,
          content: [{ type: "text" as const, text: "403 MutatedPayload" }],
          structuredContent: { statusCode: 403, error: "MutatedPayload" },
        };
      }
      if (execute && (await engine.store.frozen(intentId))) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "403 MutatedPayload" }],
          structuredContent: { statusCode: 403, error: "MutatedPayload" },
        };
      }
      if (execute && bindings && original.status === "READY") {
        const binding = bindings[intentId];
        if (!binding) throw new RuntimeError("AGENT_BINDING_MISSING");
        if (
          !(await engine.acquireMultiAgentLock(
            intentId,
            binding.semanticHash,
            binding.agentId,
          ))
        )
          return {
            isError: true,
            content: [
              { type: "text" as const, text: "423 AgentCollisionLock" },
            ],
            structuredContent: {
              statusCode: 423,
              error: "AgentCollisionLock",
              status: "LOCKED",
            },
          };
      }
      const row = execute
        ? await engine.invoke(intentId)
        : await engine.store.get(intentId);
      const output = {
        intentId: row.id,
        status:
          row.status === "READY" && (await engine.store.agentBlocked(intentId))
            ? "LOCKED"
            : row.status,
        result: row.result ? (JSON.parse(row.result) as Json) : null,
        error: row.error,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const code =
        error instanceof RuntimeError ? error.code : "GATEWAY_FAILED";
      return {
        isError: true,
        content: [{ type: "text" as const, text: code }],
      };
    }
  };
  server.registerTool(
    "actionledger_invoke",
    {
      title: "Execute an authorized durable intent",
      description:
        "Invoke a host-provisioned tool action through durable approval, identity and execution fencing. UNKNOWN never re-dispatches.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ intentId, input, operation }) =>
      handle(intentId, true, input, operation),
  );
  server.registerTool(
    "actionledger_status",
    {
      title: "Inspect a durable intent",
      description:
        "Read the durable result after an agent restart. No external mutation.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ intentId }) => handle(intentId, false),
  );
  return server;
}
export class McpToolConnector implements Connector {
  readonly binding: string;
  private validators = new Map<string, JsonSchemaValidator<Json>>();
  private finalityValidators = new Map<string, JsonSchemaValidator<Json>>();
  constructor(
    readonly id: string,
    private client: Client,
    scope: string,
    schemas: Record<string, JsonSchemaType>,
    finalitySchemas: Record<string, JsonSchemaType> = {},
  ) {
    if (!Object.keys(schemas).length)
      throw new Error("Explicit upstream tool allowlist required");
    this.binding = canonical({
      version: 1,
      scope,
      schemas: jsonSchema.parse(schemas),
      finalitySchemas: jsonSchema.parse(finalitySchemas),
    });
    const validator = new AjvJsonSchemaValidator();
    for (const [name, schema] of Object.entries(schemas))
      this.validators.set(name, validator.getValidator<Json>(schema));
    for (const [name, schema] of Object.entries(finalitySchemas)) {
      if (!this.validators.has(name))
        throw new Error("Finality schema requires an allowed tool");
      this.finalityValidators.set(name, validator.getValidator<Json>(schema));
    }
  }
  key(intentId: string): string {
    return "mcp1_" + digest(this.binding + "\0" + intentId);
  }
  parse(operation: string, input: Json): Json {
    const validate = this.validators.get(operation);
    if (!validate) throw new RuntimeError("TOOL_NOT_ALLOWED");
    const result = validate(input);
    if (
      !result.valid ||
      input === null ||
      Array.isArray(input) ||
      typeof input !== "object"
    )
      throw new RuntimeError("INVALID_TOOL_INPUT");
    return jsonSchema.parse(result.data);
  }
  async execute(context: ConnectorContext): Promise<Evidence> {
    const args = this.parse(context.intent.operation, context.intent.input) as {
      [key: string]: Json;
    };
    // No idempotency capability is inferred from MCP annotations or a tool name.
    const result = await this.client.callTool(
      { name: context.intent.operation, arguments: args },
      undefined,
      { signal: context.signal, timeout: 10000 },
    );
    if (result.isError) return { kind: "unknown", code: "UPSTREAM_TOOL_ERROR" };
    const finality = this.finalityValidators.get(context.intent.operation);
    if (
      !finality ||
      result.structuredContent === undefined ||
      !finality(result.structuredContent).valid
    )
      return { kind: "unknown", code: "UPSTREAM_RESULT_UNVERIFIED" };
    return {
      kind: "succeeded",
      reference: "mcp:" + context.key,
      result: jsonSchema.parse(result),
    };
  }
  async reconcile(): Promise<Evidence> {
    return { kind: "unknown", code: "UPSTREAM_HAS_NO_AUTHORITATIVE_LOOKUP" };
  }
}
