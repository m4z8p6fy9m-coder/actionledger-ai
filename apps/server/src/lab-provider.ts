/** Fault-capable simulator used ONLY in a disposable laboratory subprocess. */
import Fastify from "fastify";
import { PaymentProvider, tokenEqual, z } from "@actionledger/core";
const [file, token] = process.argv.slice(2);
if (!file || !token || !process.send)
  throw new Error("Lab provider requires isolated IPC configuration");
const store = new PaymentProvider(file);
const app = Fastify({ logger: false, bodyLimit: 8192 });
app.addHook("onRequest", async (req, reply) => {
  if (!tokenEqual(req.headers.authorization, "Bearer " + token))
    return reply.code(401).send({ error: "UNAUTHORIZED" });
});
app.get("/payments", async () => store.snapshot());
app.post("/payments", async (req) => store.charge(req.body));
app.post("/:fault/payments", async (req, reply) => {
  const { fault } = z
    .object({ fault: z.enum(["drop", "error"]) })
    .parse(req.params);
  store.charge(req.body);
  if (fault === "drop") {
    reply.hijack();
    req.raw.socket.destroy();
    return;
  }
  return reply
    .code(500)
    .send({ error: "SIMULATED_RESPONSE_FAILURE_AFTER_COMMIT" });
});
const address = await app.listen({ host: "127.0.0.1", port: 0 });
process.send({ type: "ready", address });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  store.close();
  process.exit(0);
}
process.once("disconnect", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
