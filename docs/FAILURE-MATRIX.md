# Reliability contract and failure matrix

ActionLedger is an independent reference implementation, not an OpenAI product. Local transactions cannot atomically commit an external effect. The independent simulated provider retains idempotency keys indefinitely; real providers need their own verified contract.

| Failure position                                    | Persisted ledger                        | Protected provider                           | Unprotected provider                                          |
| --------------------------------------------------- | --------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| Process exits before claim                          | READY, zero attempts                    | Normal execution allowed                     | Normal execution allowed                                      |
| Process exits after claim before dispatch           | UNKNOWN, one attempt                    | Explicit recovery allowed                    | Replay blocked, even if the fixture knows no payment occurred |
| Provider commits, connection drops                  | UNKNOWN, no receipt                     | Replay same key and recover original receipt | Replay blocked                                                |
| Provider commits, HTTP 500 returned                 | UNKNOWN, no receipt                     | Explicit recovery with original key          | Replay blocked                                                |
| Provider commits, malformed 201 returned            | UNKNOWN, no receipt                     | Explicit recovery with original key          | Replay blocked                                                |
| Provider commits, response times out                | UNKNOWN after real five-second deadline | Explicit recovery with original key          | Replay blocked                                                |
| Worker receives receipt then exits 86               | UNKNOWN, provider payment durable       | Two requests, one payment                    | One request, one payment, UNKNOWN retained                    |
| Old worker returns or fails after lease replacement | Ownership fence rejects stale mutation  | New owner retains its state                  | No unsafe replay allowed                                      |
| Two recovery owners compete                         | Only one can claim                      | One dispatch from admitted owner             | Recovery forbidden                                            |
| Adapter returns mismatched or malformed receipt     | UNKNOWN, no success checkpoint          | Investigate/recover within provider contract | Investigate externally                                        |
| Known success invoked again                         | SUCCEEDED, cached receipt               | No provider dispatch                         | No provider dispatch                                          |

## How to reproduce

Run pnpm install, pnpm test, and pnpm demo:reliability. The demonstration uses real child exits, independent temporary stores, an API restart, explicit synthetic operator approvals, and assertions. Test fixtures use only loopback sockets. No paid API, model, or real money is used.

The SDK tests invoke the real @openai/agents 0.21.0 function-tool interface. Tracing is disabled. A fetch guard rejects non-loopback requests in the SDK test process. They test the tool boundary and REST integration, not model behavior or hosted execution.

## Provider adapter acceptance criteria

Before adding a real provider, verify account/key scope, immutable payload comparison, retention duration, concurrent requests, authoritative receipt lookup, and handling of late settlement. Never infer that an external action failed from a timeout or negative lookup. Recovery must stop before the provider's idempotency retention expires. The current simulator deliberately has indefinite retention; no real provider adapter is supplied or certified.

## Security boundaries

Headless agent credentials cannot approve, enumerate history, read monitoring state, or retrieve the operator token through browser bootstrap. They can inspect a known action UUID including that action's approval/audit evidence, create intents, and dispatch approved actions. This is coarse API scope separation. It is not per-user authorization or a sandbox. Give an agent only its scoped token and restrict its filesystem/process access separately.

## Unverified areas

No live payment sandbox, hosted model run, Linux execution, independent audit, mobile accessibility audit, or production multi-tenant deployment has been verified locally. GitHub CI results must be checked on the actual release commit rather than inferred from workflow configuration.
