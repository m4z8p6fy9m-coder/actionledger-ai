import Fastify from "fastify";
import {
  PaymentProvider,
  DomainError,
  tokenEqual,
  z,
} from "@actionledger/core";
export function buildProvider(file: string, token: string) {
  const store = new PaymentProvider(file);
  const app = Fastify({ bodyLimit: 8192, logger: false });
  app.addHook("onRequest", async (request, reply) => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(request.hostname))
      return reply.code(403).send({ error: "HOST_DENIED" });
    if (!tokenEqual(request.headers.authorization, "Bearer " + token))
      return reply.code(401).send({ error: "UNAUTHORIZED" });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: "Invalid payment payload",
        issues: error.issues,
      });
    if (error instanceof DomainError)
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message });
    app.log.error(error);
    return reply
      .code(500)
      .send({ error: "PROVIDER_ERROR", message: "Provider request failed" });
  });
  app.get("/health", async () => ({
    ok: true,
    service: "simulated-payment-provider",
  }));
  app.get("/payments", async () => store.snapshot());
  app.post("/payments", async (request, reply) =>
    reply.code(201).send(store.charge(request.body)),
  );
  app.addHook("onClose", async () => store.close());
  return { app, store };
}
