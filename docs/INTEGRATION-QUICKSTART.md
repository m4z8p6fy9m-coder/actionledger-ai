# Local integration quickstart

This is an experimental, repository-based integration for the simulated payment service. There is no published ActionLedger npm package and no stable public API compatibility promise yet. It uses the existing JavaScript adapter; it does not require an AI provider or API key. Node.js 24+ and pnpm 11.25.0 are required.

## 1. Start the local services

From the repository root run `pnpm install` and then `pnpm dev:headless`. Keep this terminal open. The API listens on `127.0.0.1:4310` and the separate simulated provider on `127.0.0.1:4311`. Installation requires registry access; the services run locally. Headless mode creates `data/agent-token.txt` and `data/secrets.json`.

## 2. Connect a host-owned intent

The application must persist a unique business intent ID before the first invocation and reuse it with the same payment details across restarts. Do not let the model choose the ID, token, approval, or provider policy. For another project, copy `examples/openai-agents-sdk/ledger-client.mjs` into that project; the file uses built-in Node APIs and has no SDK dependency.

```js
import { readFile } from "node:fs/promises";
import { makeLedgerPayment } from "./ledger-client.mjs";

const token = (
  await readFile(process.env.ACTIONLEDGER_AGENT_TOKEN_FILE, "utf8")
).trim();
// Replace with an ID persisted by your application before any tool call.
const intentId = "invoice-2026-001";
const pay = makeLedgerPayment({ token, intentId });
const result = await pay({ recipient: "Demo recipient", amountCents: 1000 });
console.log(result);
```

Set `ACTIONLEDGER_AGENT_TOKEN_FILE` to the absolute path of `data/agent-token.txt`. The first invocation returns `PENDING_APPROVAL` and an action ID; it does not make a payment. Avoid logging credentials or supplying them to a model. Keep the operator and provider credentials in `data/secrets.json` outside the agent's access. This separation assumes a trusted host; it is not OS sandboxing or individual human authentication.

## 3. Human review and resume

A separate human operator must inspect the action using the operator credential and approve or reject it using the approval endpoint. See [API reference](API.md#scoped-credentials) for the request body and endpoints. Do not automate approval in the agent. After approval, run the same call with the same persisted ID and payload. It executes the simulated payment; subsequent calls return the stored receipt. Rejection stays final. A changed payload under the same ID is rejected.

If the outcome is uncertain, inspect the returned status and operator audit trail. The adapter requests recovery with the original ID for an UNKNOWN action; the local simulator enforces idempotency for this example. A real provider must enforce its own idempotency, with its own scope and retention rules. A database transaction alone cannot ensure exactly-once external execution. The optional enterprise runtime has a separate ledger and recovery contract; it does not automatically share dashboard records.

For the optional OpenAI Agents SDK tool wrapper and its offline tests, see [the existing SDK example](../examples/openai-agents-sdk/README.md). For the underlying request/response schema, errors and authentication, see [the API reference](API.md). The API currently has no published versioning or compatibility policy; pin the repository revision when experimenting.
