import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import {
  Ledger,
  DomainError,
  tokenEqual,
  z,
  MAX_ATTEMPTS,
  LEASE_MS,
} from "@actionledger/core";
export type ServerConfig = {
  file: string;
  apiToken: string;
  agentToken?: string;
  sessionBootstrap?: boolean;
  providerToken: string;
  providerUrl: string;
  staticRoot?: string;
  workerPath?: string;
  workerTimeoutMs?: number;
  origins?: string[];
};
const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    actor: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
const executeSchema = z
  .object({ simulateCrash: z.boolean().default(false) })
  .strict();
const idOf = (params: unknown) =>
  z.object({ id: z.string().uuid() }).parse(params).id;
export async function buildServer(config: ServerConfig) {
  if (
    config.agentToken &&
    (config.sessionBootstrap !== false ||
      config.agentToken === config.apiToken ||
      config.agentToken.length < 32)
  )
    throw new Error(
      "Scoped agent access requires a distinct 32+ character token and disabled session bootstrap",
    );
  const ledger = new Ledger(config.file);
  const app = Fastify({
    bodyLimit: 8192,
    logger: {
      level: process.env.LOG_LEVEL ?? "warn",
      redact: ["req.headers.authorization"],
    },
    requestTimeout: 15000,
  });
  const children = new Set<ReturnType<typeof spawn>>();
  const origins = new Set(
    config.origins ?? [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://127.0.0.1:4310",
      "http://localhost:4310",
    ],
  );
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Request-Id", request.id)
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    if (!["127.0.0.1", "localhost", "[::1]"].includes(request.hostname))
      return reply
        .code(403)
        .send({ error: "HOST_DENIED", message: "Loopback host required" });
    if (request.headers.origin && !origins.has(request.headers.origin))
      return reply
        .code(403)
        .send({ error: "ORIGIN_DENIED", message: "Origin is not allowed" });
    const route = request.url.split("?")[0];
    if (route === "/api/session" && config.sessionBootstrap === false)
      return reply.code(404).send({
        error: "SESSION_DISABLED",
        message: "Browser credential bootstrap is disabled",
      });
    if (
      route.startsWith("/api/") &&
      !["/api/health", "/api/session"].includes(route)
    ) {
      const operator = tokenEqual(
        request.headers.authorization,
        "Bearer " + config.apiToken,
      );
      const agent =
        config.agentToken &&
        tokenEqual(
          request.headers.authorization,
          "Bearer " + config.agentToken,
        );
      if (!operator && !agent)
        return reply.code(401).send({
          error: "UNAUTHORIZED",
          message: "Local API bearer token required",
        });
      const agentRoute =
        (request.method === "POST" && route === "/api/actions") ||
        (request.method === "GET" &&
          /^\/api\/actions\/[0-9a-f-]{36}$/.test(route)) ||
        (request.method === "POST" &&
          /^\/api\/actions\/[0-9a-f-]{36}\/(execute|recover)$/.test(route));
      if (!operator && !agentRoute)
        return reply.code(403).send({
          error: "SCOPE_DENIED",
          message:
            "Agent credentials cannot approve actions or access operator routes",
        });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: "Request validation failed",
        issues: error.issues,
      });
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error instanceof Error ? error.message : "Invalid request",
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({
        error: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "Invalid request",
      });
    request.log.error(error);
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "Request failed. Check local server logs.",
    });
  });
  const providerState = async () => {
    const res = await fetch(config.providerUrl + "/payments", {
      headers: { authorization: "Bearer " + config.providerToken },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok)
      throw new DomainError(
        "PROVIDER_UNAVAILABLE",
        "Payment provider is unavailable",
        503,
      );
    return res.json();
  };
  const run = async (id: string, recovery: boolean, crash: boolean) => {
    ledger.expire(id);
    const before = ledger.get(id);
    if (before.status === "SUCCEEDED")
      return { action: before, crashed: false, cached: true };
    // Validate before spawning. The worker atomically claims again; this check is only for a useful HTTP error.
    if (before.status === "RUNNING")
      throw new DomainError(
        "IN_PROGRESS",
        "Execution is active. Recovery waits until its lease expires.",
      );
    if (
      before.status === "UNKNOWN" &&
      (!recovery || JSON.parse(before.payload).providerMode !== "idempotent")
    )
      throw new DomainError(
        "UNSAFE_RETRY",
        "Uncertain external effect: automatic replay is blocked without provider idempotency.",
      );
    if (!["READY", "UNKNOWN"].includes(before.status))
      throw new DomainError(
        "APPROVAL_REQUIRED",
        "Approve this payment before execution",
      );
    if (before.attempts >= MAX_ATTEMPTS)
      throw new DomainError(
        "ATTEMPTS_EXHAUSTED",
        "Retry limit reached; manual investigation required",
      );
    const owner = randomUUID();
    const worker =
      config.workerPath ??
      fileURLToPath(
        new URL("./worker" + extname(import.meta.url), import.meta.url),
      );
    const args = [
      ...(worker.endsWith(".ts") ? ["--import", "tsx"] : []),
      worker,
      config.file,
      id,
      owner,
      String(recovery),
      String(crash),
    ];
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        PROVIDER_TOKEN: config.providerToken,
        PROVIDER_URL: config.providerUrl,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    children.add(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const timeout = setTimeout(
      () => child.kill(),
      config.workerTimeoutMs ?? 12000,
    );
    timeout.unref();
    const code = await new Promise<number | null>((res, rej) => {
      child.once("error", rej);
      child.once("close", res);
    }).finally(() => {
      clearTimeout(timeout);
      children.delete(child);
    });
    if (code !== 0)
      ledger.markUncertain(
        id,
        owner,
        code === 86
          ? "Worker terminated after provider commit, before ledger checkpoint"
          : "Execution worker exited before a durable result",
      );
    const action = ledger.get(id);
    if (code === 86) return { action, crashed: true, cached: false };
    if (code !== 0) {
      app.log.warn({ actionId: id, code, stderr }, "Execution worker failed");
      throw new DomainError(
        "EXECUTION_INCOMPLETE",
        "Worker could not complete. Inspect the persisted action state before recovery.",
        503,
      );
    }
    return { action, crashed: false, cached: false };
  };
  app.get("/api/health", async () => ({
    ok: true,
    service: "ActionLedger AI",
    version: "0.3.0",
  }));
  app.get("/api/session", async () => ({ token: config.apiToken }));
  app.get("/api/state", async () => {
    let provider: unknown = null;
    let providerError: string | null = null;
    try {
      provider = await providerState();
    } catch {
      providerError = "Payment provider unavailable";
    }
    return {
      ...ledger.snapshot(),
      provider,
      providerError,
      policy: {
        leaseMs: LEASE_MS,
        maxAttempts: MAX_ATTEMPTS,
        paymentApproval: "always",
        automaticRetry: false,
      },
    };
  });
  app.get("/api/action-page", async (request) =>
    ledger.listPage(request.query),
  );
  // Keep the original array response compatible with existing adapters.
  app.get("/api/actions", async (request) => {
    const query = z.record(z.unknown()).parse(request.query);
    return ledger.listPage({ ...query, limit: query.limit ?? 50 }).items;
  });
  app.get("/api/actions/export", async (request, reply) => {
    const csv = ledger.exportActions(request.query);
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        'attachment; filename="actionledger-actions.csv"',
      )
      .send(csv);
  });
  app.post("/api/actions", async (request, reply) => {
    const result = ledger.create(request.body);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });
  app.get("/api/actions/:id", async (request) =>
    ledger.detail(idOf(request.params)),
  );
  app.post("/api/actions/:id/approval", async (request) => {
    const body = decisionSchema.parse(request.body);
    return ledger.decide(
      idOf(request.params),
      body.decision,
      body.actor,
      body.reason,
    );
  });
  app.post("/api/actions/:id/execute", async (request) => {
    const body = executeSchema.parse(request.body ?? {});
    return run(idOf(request.params), false, body.simulateCrash);
  });
  app.post("/api/actions/:id/recover", async (request) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return run(idOf(request.params), true, false);
  });
  app.get("/api/audit", async (request) => {
    const { after, limit } = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .strict()
      .parse(request.query);
    return ledger.db
      .prepare("SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT ?")
      .all(after, limit);
  });
  if (config.staticRoot) {
    await app.register(fastifyStatic, { root: resolve(config.staticRoot) });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "NOT_FOUND" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    for (const child of children) child.kill();
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((res) => {
            if (child.exitCode !== null) res();
            else child.once("close", () => res());
          }),
      ),
    );
    ledger.close();
  });
  return { app, ledger, run };
}
