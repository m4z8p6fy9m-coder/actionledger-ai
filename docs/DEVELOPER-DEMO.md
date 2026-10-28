# ActionLedger: a two-minute developer tour

An external payment can succeed just before an agent process crashes. If the
agent retries without knowing the result, it can pay twice. ActionLedger records
the uncertain outcome and uses the provider's actual capabilities to decide
whether an explicit recovery is safe to attempt.

ActionLedger is an independent, experimental open-source project. This tour uses
simulated payments and does not call a hosted model or charge a real account.

## See the crash window

With Node.js 24+ and pnpm 11.25.0, install the repository dependencies and run:

```sh
pnpm install --frozen-lockfile
pnpm demo:reliability
```

The script runs an actual child-process exit and restart with isolated local
stores. It asserts two outcomes:

| Provider policy         | Attempts | Simulated payments | Final ledger state                  |
| ----------------------- | -------: | -----------------: | ----------------------------------- |
| Idempotency enforced    |        2 |                  1 | `SUCCEEDED` after explicit recovery |
| No provider idempotency |        1 |                  1 | `UNKNOWN`; replay blocked           |

For the visual version, run `pnpm dev`, open the dashboard's Crash lab, and
follow create → human approval → execute and crash → inspect → recover. Repeat
with no provider idempotency. Stop the services with Ctrl+C. Dashboard data and
credentials persist in `data/`; do not share that directory.

## Compare strategies

The [strategy comparison](STRATEGY-COMPARISON.md) describes the tested crash,
lost-response and concurrency scenarios, including a deliberately unsafe
positive control. Its naive baseline demonstrates a duplicate using two
unprotected calls; it is not a matched crash schedule or an implementation of
the OpenAI SDK. Provider key expiry is not tested by the simulator.

To run the wider comparison and verify its evidence, choose a new output filename:

```sh
pnpm lab --seed 5409 --output evidence.json
pnpm evidence:verify evidence.json
```

The verifier checks report consistency and the fingerprint, not authenticity or
formal correctness. The seeded lab uses simulated effects; results do not prove
real provider behavior. On 28 October 2026, a local Windows run against base
commit `4b6dda5` passed 8 scenarios and 36 checks, and its evidence verified.

## Connect an agent

The [local integration quickstart](INTEGRATION-QUICKSTART.md) shows the existing
JavaScript adapter, a host-owned durable intent, separate human approval and
resume. The [OpenAI Agents SDK example](../examples/openai-agents-sdk/README.md)
wraps the adapter as a tool and has six offline tests; it does not require an API
key for those tests. The repository does not currently offer an npm installation
path or a stable public API promise.

```sh
pnpm --filter @actionledger/core build
pnpm exec vitest run tests/sdk.test.ts
```

## Boundaries worth checking

- A local transaction cannot guarantee exactly-once external effects. Safe
  retries depend on the provider's own key scope, payload rules and retention.
- A timeout or absent receipt alone does not prove that no effect occurred.
  Unprotected `UNKNOWN` requires external investigation; do not force a retry.
- The dashboard and optional experimental MCP/runtime use separate ledgers and
  different recovery policies. Direct provider calls bypass ActionLedger.
- The Stripe connector has not been validated against a real Stripe account in
  this tour, and the project has no independent security certification.

Try the [independent reproduction checklist](INDEPENDENT-REPRODUCTION.md) and
share the actual environment, command output and difficulties you encountered.
