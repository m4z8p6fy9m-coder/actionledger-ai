import Stripe from "stripe";
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
import type { ActionStore } from "./store.js";
const paymentSchema = z
  .object({
    amountCents: z.number().int().min(1).max(99999999),
    currency: z.enum(["eur", "usd", "gbp"]),
    customer: z.string().regex(/^cus_[a-zA-Z0-9]+$/),
    paymentMethod: z.string().regex(/^pm_[a-zA-Z0-9]+$/),
  })
  .strict();
export type StripePayment = z.infer<typeof paymentSchema>;
export type StripeConfig = {
  namespace: string;
  account?: string;
  liveMode: boolean;
  webhookSecret: string;
};
/** Only saved payment-method tokens are accepted; never raw card data. */
export class StripeConnector implements Connector {
  readonly id = "stripe";
  readonly binding: string;
  constructor(
    readonly stripe: Stripe,
    private config: StripeConfig,
  ) {
    if (
      !/^[a-zA-Z0-9_.:-]{1,100}$/.test(config.namespace) ||
      !config.webhookSecret.startsWith("whsec_")
    )
      throw new Error("Invalid Stripe scope or webhook secret");
    if (config.account && !/^acct_[a-zA-Z0-9]+$/.test(config.account))
      throw new Error("Invalid Stripe account");
    this.binding = canonical({
      version: 1,
      apiVersion: Stripe.API_VERSION,
      namespace: config.namespace,
      account: config.account ?? null,
      liveMode: config.liveMode,
    });
  }
  key(intentId: string): string {
    return "al1_" + digest(this.binding + "\0" + intentId);
  }
  parse(operation: string, input: Json): Json {
    if (operation !== "payment.create")
      throw new RuntimeError("OPERATION_NOT_ALLOWED");
    return paymentSchema.parse(input);
  }
  private options() {
    return this.config.account ? { stripeAccount: this.config.account } : {};
  }
  private verified(
    pi: Stripe.PaymentIntent,
    context: ConnectorContext,
  ): Evidence {
    const input = paymentSchema.parse(context.intent.input);
    const customer =
      typeof pi.customer === "string" ? pi.customer : pi.customer?.id;
    const method =
      typeof pi.payment_method === "string"
        ? pi.payment_method
        : pi.payment_method?.id;
    if (
      pi.metadata.actionledger_key !== context.key ||
      pi.metadata.actionledger_digest !== context.fingerprint ||
      pi.amount !== input.amountCents ||
      pi.currency !== input.currency ||
      customer !== input.customer ||
      method !== input.paymentMethod ||
      pi.livemode !== this.config.liveMode ||
      (context.reference !== null && context.reference !== pi.id)
    )
      throw new RuntimeError("STRIPE_EVIDENCE_MISMATCH");
    if (pi.status === "succeeded") {
      if (pi.amount_received !== input.amountCents)
        throw new RuntimeError("STRIPE_AMOUNT_MISMATCH");
      return {
        kind: "succeeded",
        reference: pi.id,
        result: {
          provider: "stripe",
          paymentIntentId: pi.id,
          amountCents: pi.amount_received,
          currency: pi.currency,
        },
      };
    }
    if (pi.status === "canceled")
      return { kind: "rejected", reference: pi.id, code: "STRIPE_CANCELED" };
    // payment_failed/requires_payment_method is not a terminal canceled intent.
    return {
      kind: "unknown",
      reference: pi.id,
      code: "STRIPE_" + pi.status.toUpperCase(),
    };
  }
  async execute(context: ConnectorContext): Promise<Evidence> {
    const input = paymentSchema.parse(
      this.parse(context.intent.operation, context.intent.input),
    );
    if (context.signal.aborted) throw new RuntimeError("CONNECTOR_DEADLINE");
    try {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency,
          customer: input.customer,
          payment_method: input.paymentMethod,
          allowed_payment_method_types: ["card"],
          confirm: true,
          off_session: true,
          metadata: {
            actionledger_key: context.key,
            actionledger_digest: context.fingerprint,
          },
        },
        {
          ...this.options(),
          idempotencyKey: context.key,
          maxNetworkRetries: 0,
          timeout: 8000,
        },
      );
      const outcome = this.verified(pi, context);
      await context.bindReference(pi.id);
      return outcome;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      // Even a declined/invalid retry must not erase a possibly committed prior outcome.
      if (error instanceof Stripe.errors.StripeError) {
        const status = error.statusCode;
        return {
          kind: "unknown",
          code:
            status === 409
              ? "STRIPE_CONFLICT"
              : status === 429
                ? "STRIPE_RATE_LIMIT"
                : status && status >= 500
                  ? "STRIPE_SERVER_ERROR"
                  : error.type === "StripeConnectionError"
                    ? "STRIPE_NETWORK"
                    : "STRIPE_REQUEST_UNCERTAIN",
        };
      }
      throw error;
    }
  }
  async reconcile(context: ConnectorContext): Promise<Evidence> {
    if (context.signal.aborted) throw new RuntimeError("CONNECTOR_DEADLINE");
    const opts = { ...this.options(), maxNetworkRetries: 0, timeout: 8000 };
    if (context.reference) {
      const pi = await this.stripe.paymentIntents.retrieve(
        context.reference,
        {},
        opts,
      );
      return this.verified(pi, context);
    }
    // Stripe has no generic GET-by-idempotency-key. Metadata search may lag.
    const found = await this.stripe.paymentIntents.search(
      { query: "metadata['actionledger_key']:'" + context.key + "'", limit: 2 },
      opts,
    );
    if (found.has_more || found.data.length > 1)
      throw new RuntimeError("STRIPE_MULTIPLE_MATCHES");
    if (found.data.length === 0)
      return { kind: "unknown", code: "STRIPE_SEARCH_NOT_FINAL" };
    const pi = await this.stripe.paymentIntents.retrieve(
      found.data[0].id,
      {},
      opts,
    );
    return this.verified(pi, context);
  }
  async webhook(
    raw: Buffer,
    signature: string,
    store: ActionStore,
  ): Promise<void> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        raw,
        signature,
        this.config.webhookSecret,
        300,
      );
    } catch {
      throw new RuntimeError("INVALID_STRIPE_SIGNATURE");
    }
    const parsedEvent = z
      .object({
        id: z.string().regex(/^evt_[a-zA-Z0-9_]+$/),
        type: z.string(),
        livemode: z.boolean(),
        account: z.string().optional(),
        data: z.object({ object: z.unknown() }),
      })
      .safeParse(event);
    if (!parsedEvent.success) throw new RuntimeError("INVALID_STRIPE_EVENT");
    if (
      event.livemode !== this.config.liveMode ||
      (event.account ?? null) !== (this.config.account ?? null)
    )
      throw new RuntimeError("STRIPE_ACCOUNT_MISMATCH");
    if (
      ![
        "payment_intent.succeeded",
        "payment_intent.canceled",
        "payment_intent.payment_failed",
      ].includes(event.type)
    )
      return;
    const object = z
      .object({
        object: z.literal("payment_intent"),
        metadata: z.record(z.string(), z.string()).optional(),
      })
      .safeParse(parsedEvent.data.data.object);
    if (!object.success) throw new RuntimeError("INVALID_STRIPE_EVENT");
    const key = object.data.metadata?.actionledger_key;
    if (!key || !/^al1_[a-f0-9]{64}$/.test(key)) return;
    // Persist event dedupe + schedule a fresh authenticated provider read atomically.
    await store.enqueueWebhook(this.id, event.id, key);
  }
}
