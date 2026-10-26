import { z } from "zod";
import {
  canonical,
  digest,
  RuntimeError,
  type Connector,
  type ConnectorContext,
  type Evidence,
  type Json,
} from "./contracts.js";
const inputSchema = z
  .object({
    recipient: z.string().min(1).max(100),
    amountCents: z.number().int().positive().max(100000000),
  })
  .strict();
const receiptSchema = z.object({
  id: z.string(),
  recipient: z.string(),
  amountCents: z.number(),
  currency: z.literal("EUR"),
  createdAt: z.string(),
});
const snapshotSchema = z.object({
  payments: z.array(receiptSchema.extend({ logicalKey: z.string() })),
});
export class SimulatedConnector implements Connector {
  readonly id = "simulated";
  readonly binding: string;
  constructor(
    private url: string,
    private token: string,
    namespace: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/" ||
      !["http:", "https:"].includes(parsed.protocol)
    )
      throw new Error("Provider must be a bare origin");
    if (
      parsed.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    )
      throw new Error("Plain HTTP provider must be loopback");
    this.url = parsed.origin;
    this.binding = canonical({ version: 1, url: this.url, namespace });
  }
  key(id: string) {
    return "sim1_" + digest(this.binding + "\0" + id);
  }
  parse(operation: string, input: Json): Json {
    if (operation !== "payment.create")
      throw new RuntimeError("OPERATION_NOT_ALLOWED");
    return inputSchema.parse(input);
  }
  private result(raw: unknown, context: ConnectorContext): Evidence {
    const receipt = receiptSchema.parse(raw);
    const input = inputSchema.parse(context.intent.input);
    if (
      receipt.recipient !== input.recipient ||
      receipt.amountCents !== input.amountCents
    )
      throw new RuntimeError("PROVIDER_EVIDENCE_MISMATCH");
    return { kind: "succeeded", reference: receipt.id, result: receipt };
  }
  async execute(context: ConnectorContext): Promise<Evidence> {
    const input = this.parse(
      context.intent.operation,
      context.intent.input,
    ) as z.infer<typeof inputSchema>;
    const response = await fetch(this.url + "/payments", {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...input,
        idempotencyKey: context.key,
        currency: "EUR",
        providerMode: "idempotent",
        description: "Runtime payment",
      }),
      signal: context.signal,
    });
    if (!response.ok) throw new RuntimeError("PROVIDER_UNCERTAIN");
    return this.result(await response.json(), context);
  }
  async reconcile(context: ConnectorContext): Promise<Evidence> {
    const response = await fetch(this.url + "/payments", {
      headers: { authorization: "Bearer " + this.token },
      signal: context.signal,
    });
    if (!response.ok) throw new RuntimeError("PROVIDER_LOOKUP_FAILED");
    const snapshot = snapshotSchema.parse(await response.json());
    const matches = snapshot.payments.filter(
      (p) => p.logicalKey === context.key,
    );
    if (matches.length !== 1)
      return { kind: "unknown", code: "PROVIDER_LOOKUP_NOT_FINAL" };
    return this.result(matches[0], context);
  }
}
