# Chaos Stress Test Evidence Report

- **Project:** ActionLedger AI Enterprise Runtime
- **Run date:** 2026-10-26
- **Environment:** Isolated local PostgreSQL instance and a local mocked Stripe HTTP provider
- **Outcome:** Pass for the scenarios exercised

## Objective and fault model

Evaluate whether the runtime preserves its recovery contract when a simulated provider records a payment but its response is lost, while PostgreSQL sessions are terminated immediately before selected transaction commits. The test used only its own disposable PostgreSQL sessions and simulated payments; it did not contact Stripe or process real money.

## Observed results

| Measure                               | Observed |
| ------------------------------------- | -------: |
| Actions                               |       24 |
| Simulated payments                    |       24 |
| Provider POST requests                |       24 |
| Terminated PostgreSQL sessions        |       24 |
| Final UNKNOWN actions                 |       24 |
| Final SUCCEEDED actions               |        0 |
| Duplicate simulated payments observed |        0 |

The run demonstrated **100% consistency within this test**: all 24 actions had exactly one simulated payment and one POST request, and all 24 unresolved outcomes remained safely isolated as UNKNOWN after recovery and repeat invocation. No automatic re-dispatch was observed. These results are bounded to this test run and fault model.

## Defect identified and corrected

An earlier run exposed an unhandled PostgreSQL client socket error during a hard connection reset. This could terminate the Node.js process. The connection handling was corrected to handle client and pool errors, discard failed connections, and avoid masking the original transaction failure when rollback itself fails. The subsequent run produced the results above.

## Recovery contract and operating boundaries

- An UNKNOWN outcome is not proof of success or failure. Read-only reconciliation may continue; automatic force-retry remains prohibited. Operators must investigate the relevant Stripe or REST provider dashboard, or another authoritative provider source, before deciding on further action.
- The generic REST provider must independently enforce idempotency for the supplied key. Sending an Idempotency-Key header alone does not provide this guarantee.
- Existing intents without causal data remain unsigned for backward compatibility; they do not receive the signature guarantee enforced for causal manifest intents.
- A 403 MutatedPayload response creates a persistent freeze. There is deliberately no automated unfreeze; investigation requires an operator-controlled procedure. An already dispatched external request cannot be undone by a subsequent freeze.
- This experiment exercises selected response-loss and database-disconnect scenarios. It is not a mathematical or formal 100% certification, a proof of exactly-once external execution, a real Stripe integration test, or a comprehensive production load test. Local database transactions alone cannot guarantee exactly-once execution by an external provider.

## Reproduction

The test entry point is [chaos-stresstest.ts](../../packages/runtime/test/chaos-stresstest.ts). Set TEST_DATABASE_URL to a disposable local PostgreSQL database and CHAOS_DISPOSABLE=YES, then run `pnpm test:chaos`. The test creates persistent fixture records and terminates its own database sessions; never point it at a shared or production database. See the [Enterprise Runtime guide](../ENTERPRISE-RUNTIME.md) for setup, security boundaries and recovery limitations.
