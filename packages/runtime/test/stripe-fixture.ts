import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import Stripe from "stripe";
import { StripeConnector } from "../src/stripe.js";
export const webhookSecret = "whsec_local_regression_fixture";
export const stripeConfig = {
  namespace: "regression",
  liveMode: false,
  webhookSecret,
};
export async function stripeFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE payments(key TEXT PRIMARY KEY,body TEXT NOT NULL)");
  let posts = 0;
  let reads = 0;
  let errorStatus = 0;
  let drop = false;
  let hideSearch = false;
  let currentStatus = "succeeded";
  let corrupt = false;
  const respond = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "request-id": "req_fixture",
    });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method === "POST" && url.pathname === "/v1/payment_intents") {
        posts++;
        if (errorStatus) {
          respond(
            response,
            {
              error: {
                type: errorStatus === 429 ? "rate_limit_error" : "api_error",
                message: "Fixture failure",
              },
            },
            errorStatus,
          );
          return;
        }
        const key = String(request.headers["idempotency-key"]);
        const existing = db
          .prepare("SELECT body FROM payments WHERE key=?")
          .get(key);
        if (existing) {
          respond(response, JSON.parse(String(existing.body)));
          return;
        }
        const params = new URLSearchParams(body);
        const pi = {
          id: "pi_fixture" + posts,
          object: "payment_intent",
          status: currentStatus,
          amount: Number(params.get("amount")),
          amount_received:
            currentStatus === "succeeded" ? Number(params.get("amount")) : 0,
          currency: params.get("currency"),
          customer: params.get("customer"),
          payment_method: params.get("payment_method"),
          livemode: false,
          metadata: {
            actionledger_key: params.get("metadata[actionledger_key]"),
            actionledger_digest: params.get("metadata[actionledger_digest]"),
          },
          client_secret: "pi_private_fixture",
        };
        db.prepare("INSERT INTO payments VALUES(?,?)").run(
          key,
          JSON.stringify(pi),
        );
        if (drop) {
          response.destroy();
          return;
        }
        respond(response, corrupt ? { ...pi, amount: pi.amount + 1 } : pi);
        return;
      }
      reads++;
      const all = db
        .prepare("SELECT body FROM payments")
        .all()
        .map((row) => JSON.parse(String(row.body)) as Stripe.PaymentIntent);
      if (url.pathname === "/v1/payment_intents/search") {
        respond(response, {
          object: "search_result",
          data: hideSearch ? [] : all,
          has_more: false,
          url: url.pathname,
        });
        return;
      }
      const found = all.find((pi) => url.pathname.endsWith("/" + pi.id));
      if (found) {
        respond(response, found);
        return;
      }
      respond(
        response,
        {
          error: { type: "invalid_request_error", message: "Missing fixture" },
        },
        404,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  const client = new Stripe("sk_test_fixture", {
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: Stripe.API_VERSION,
    maxNetworkRetries: 0,
    timeout: 1000,
  });
  return {
    url: "http://127.0.0.1:" + address.port,
    client,
    connector: new StripeConnector(client, stripeConfig),
    mode(options: {
      errorStatus?: number;
      drop?: boolean;
      hideSearch?: boolean;
      status?: string;
      corrupt?: boolean;
    }) {
      errorStatus = options.errorStatus ?? 0;
      drop = options.drop ?? false;
      hideSearch = options.hideSearch ?? false;
      currentStatus = options.status ?? "succeeded";
      corrupt = options.corrupt ?? false;
    },
    update(status: string) {
      const rows = db.prepare("SELECT key,body FROM payments").all();
      for (const row of rows) {
        const pi = JSON.parse(String(row.body));
        pi.status = status;
        pi.amount_received = status === "succeeded" ? pi.amount : 0;
        db.prepare("UPDATE payments SET body=? WHERE key=?").run(
          JSON.stringify(pi),
          String(row.key),
        );
      }
    },
    payment: () => {
      const row = db.prepare("SELECT body FROM payments LIMIT 1").get();
      return row
        ? (JSON.parse(String(row.body)) as Stripe.PaymentIntent)
        : null;
    },
    counts: () => ({
      posts,
      reads,
      payments: Number(db.prepare("SELECT COUNT(*) n FROM payments").get()!.n),
    }),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      db.close();
    },
  };
}
