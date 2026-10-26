import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
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

/** Host-configured endpoint and schemas are trusted; HTTP responses do not prove external finality by default. */
export class RestConnector implements Connector {
  readonly binding: string;
  private input: JsonSchemaValidator<Json>;
  private finality: JsonSchemaValidator<Json> | undefined;
  constructor(
    readonly id: string,
    private endpoint: string,
    private token: string | undefined,
    scope: string,
    private operation: string,
    inputSchema: JsonSchemaType,
    finalitySchema?: JsonSchemaType,
  ) {
    const url = new URL(endpoint);
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
        "REST endpoint must be HTTPS or loopback HTTP without embedded credentials",
      );
    this.binding = canonical({
      version: 1,
      endpoint: url.href,
      scope,
      operation,
      inputSchema: jsonSchema.parse(inputSchema),
      finalitySchema: finalitySchema ? jsonSchema.parse(finalitySchema) : null,
    });
    const validator = new AjvJsonSchemaValidator();
    this.input = validator.getValidator<Json>(inputSchema);
    this.finality = finalitySchema
      ? validator.getValidator<Json>(finalitySchema)
      : undefined;
  }
  key(intentId: string): string {
    return "rest1_" + digest(this.binding + "\0" + intentId);
  }
  parse(operation: string, value: Json): Json {
    if (operation !== this.operation)
      throw new RuntimeError("OPERATION_NOT_ALLOWED");
    const parsed = this.input(value);
    if (!parsed.valid) throw new RuntimeError("INVALID_TOOL_INPUT");
    return jsonSchema.parse(parsed.data);
  }
  async execute(context: ConnectorContext): Promise<Evidence> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal: context.signal,
      headers: {
        "content-type": "application/json",
        "idempotency-key": context.key,
        ...(this.token ? { authorization: "Bearer " + this.token } : {}),
      },
      body: canonical(
        this.parse(context.intent.operation, context.intent.input),
      ),
    });
    if (!response.ok)
      return { kind: "unknown", code: "REST_RESPONSE_UNCERTAIN" };
    const declared = Number(response.headers.get("content-length"));
    if (declared > 262144) {
      await response.body?.cancel();
      return { kind: "unknown", code: "REST_RESPONSE_TOO_LARGE" };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 262144) {
          await reader.cancel();
          return { kind: "unknown", code: "REST_RESPONSE_TOO_LARGE" };
        }
        chunks.push(next.value);
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Json;
    try {
      body = jsonSchema.parse(JSON.parse(text));
    } catch {
      return { kind: "unknown", code: "REST_RESPONSE_INVALID" };
    }
    if (!this.finality || !this.finality(body).valid)
      return { kind: "unknown", code: "REST_RESULT_UNVERIFIED" };
    return {
      kind: "succeeded",
      reference: "rest:" + context.key,
      result: body,
    };
  }
  async reconcile(): Promise<Evidence> {
    return { kind: "unknown", code: "REST_HAS_NO_AUTHORITATIVE_LOOKUP" };
  }
}
