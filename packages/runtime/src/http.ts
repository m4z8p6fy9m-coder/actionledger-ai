import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ActionEngine, RecoveryLoop } from "./engine.js";
import type { StripeConnector } from "./stripe.js";
import { RuntimeError } from "./contracts.js";
const decision = z
  .object({
    decision: z.enum(["approve", "reject"]),
    actor: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export function createRuntimeHttp(
  engine: ActionEngine,
  loop: RecoveryLoop,
  config: {
    operatorToken: string;
    agentToken: string;
    intentIds: readonly string[];
    stripe?: StripeConnector;
  },
) {
  if (
    config.operatorToken.length < 32 ||
    config.agentToken.length < 32 ||
    config.operatorToken === config.agentToken
  )
    throw new Error(
      "Distinct 32+ character operator and agent credentials required",
    );
  const app = Fastify({
    bodyLimit: 65536,
    requestTimeout: 15000,
    logger: false,
  });
  const ids = new Set(config.intentIds);
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
    if (request.headers.origin)
      return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
    if (
      request.url.split("?")[0] === "/health" ||
      request.url.split("?")[0] === "/stripe/webhook"
    )
      return;
    const actual = Buffer.from(request.headers.authorization ?? "");
    const matches = (token: string) => {
      const expected = Buffer.from("Bearer " + token);
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    };
    const operator = matches(config.operatorToken);
    const agent = matches(config.agentToken);
    if (!operator && !agent)
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    if (request.method !== "GET" && !operator)
      return reply.code(403).send({ error: "OPERATOR_REQUIRED" });
  });
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(503).send({ error: "RUNTIME_REQUEST_FAILED" }),
  );
  app.get("/health", async (_request, reply) => {
    const recovery = loop.health;
    const ready = recovery.running && !recovery.lastError;
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? "ok" : "degraded", recovery });
  });
  app.get("/v1/intents/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!ids.has(id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const row = await engine.store.get(id);
    return {
      id: row.id,
      status: row.status,
      fence: row.fence,
      attempts: row.attempts,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
    };
  });
  app.post("/v1/intents/:id/decision", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!ids.has(id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const raw = request.body as Buffer;
    const parsed = decision.safeParse(
      (() => {
        try {
          return JSON.parse(raw.toString("utf8"));
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_DECISION" });
    try {
      const row = await engine.store.decide(
        id,
        parsed.data.decision,
        parsed.data.actor,
        parsed.data.reason,
      );
      return { id: row.id, status: row.status };
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "DECISION_FINAL")
        return reply.code(409).send({ error: "DECISION_CONFLICT" });
      throw error;
    }
  });
  app.post("/stripe/webhook", async (request, reply) => {
    if (!config.stripe)
      return reply.code(404).send({ error: "NOT_CONFIGURED" });
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || !Buffer.isBuffer(request.body))
      return reply.code(400).send({ error: "INVALID_WEBHOOK" });
    try {
      await config.stripe.webhook(request.body, signature, engine.store);
    } catch (error) {
      const invalid =
        error instanceof Error &&
        [
          "INVALID_STRIPE_SIGNATURE",
          "STRIPE_ACCOUNT_MISMATCH",
          "INVALID_STRIPE_EVENT",
        ].includes(error.message);
      return reply
        .code(invalid ? 400 : 503)
        .send({ error: invalid ? "INVALID_WEBHOOK" : "WEBHOOK_STORE_FAILED" });
    }
    return reply.code(202).send({ accepted: true });
  });
  return app;
}
