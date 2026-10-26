import Stripe from "stripe";
import { StripeConnector } from "../../src/stripe.js";
import { ActionEngine } from "../../src/engine.js";
import { ActionStore } from "../../src/store.js";
import { SqliteDriver } from "../../src/driver.js";
const [file, url, id] = process.argv.slice(2);
const origin = new URL(url);
if (origin.hostname !== "127.0.0.1")
  throw new Error("Fixture must stay on loopback");
const stripe = new Stripe("sk_test_fixture", {
  host: origin.hostname,
  port: Number(origin.port),
  protocol: "http",
  httpClient: Stripe.createFetchHttpClient(),
  apiVersion: Stripe.API_VERSION,
  maxNetworkRetries: 0,
});
const connector = new StripeConnector(stripe, {
  namespace: "regression",
  liveMode: false,
  webhookSecret: "whsec_local_regression_fixture",
});
const original = connector.execute.bind(connector);
connector.execute = (context) =>
  original({
    ...context,
    bindReference: async () => {
      process.exit(86);
    },
  });
const store = new ActionStore(new SqliteDriver(file));
await store.initialize();
await new ActionEngine(store, [connector]).invoke(id);
throw new Error("Expected a real process crash before checkpoint");
