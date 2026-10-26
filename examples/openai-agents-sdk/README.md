# OpenAI Agents SDK integration

Independent example, not affiliated with or endorsed by OpenAI.

The actual function-tool boundary is covered by six offline integration tests using pinned @openai/agents 0.21.0 and Zod 4. The core application has no SDK runtime dependency. Installing development dependencies downloads the SDK, but development servers and builds never load it. Tests disable tracing and make no model calls; no OpenAI API key is needed.

Run pnpm test or pnpm exec vitest run tests/sdk.test.ts after building core. The tests cover pending human approval, cached receipt reuse, real child crash recovery, durable rejection across restart, immutable payload conflicts, schema rejection, and overlapping invocations. They do not test a hosted agent run.

## Use in an agent host

1. Persist one application-owned invoice intent ID before running the agent. Reuse it after every restart. Do not use a model-generated key or a fresh tool-call ID.
2. Start pnpm dev:headless. Read only data/agent-token.txt into the trusted host. Keep operator/provider credentials and their files inaccessible to the agent.
3. Import createPaymentTool from tool.example.mjs and call it with token, intentId, and optionally baseUrl. Supply the returned tool to your SDK Agent. For a separate project, install the pinned SDK and Zod 4 and copy both example files.
4. First invocation records PENDING_APPROVAL. A human uses the operator REST credential to inspect and approve that exact intent. The tool cannot approve it with its scoped credential.
5. Resume the same intent and payload. READY executes; SUCCEEDED returns the stored receipt; protected UNKNOWN requests recovery; REJECTED remains rejected. Execution errors are rethrown by the SDK tool, not disguised as successful results.

The model-visible parameters contain only recipient and integer amountCents. Tokens, intent IDs, provider policy, approval decisions, and retry keys are supplied by the host. The plain adapter never retries a failed HTTP write by itself. An interrupted request requires inspecting durable state and resuming the same logical intent.

Default dashboard mode uses one trusted operator credential and exposes same-origin browser bootstrap. Do not rely on scoped-agent separation while also exposing default dashboard mode against the same stores. Headless mode disables credential bootstrap and has no browser approval interface. It is not OS isolation or individual human authentication.

The [official SDK guide](https://developers.openai.com/api/docs/guides/agents/quickstart) describes Agent/tool wiring. Calling a hosted model in your own application requires its own provider setup; this example and its tests do not do that.
