# Independent reproduction checklist

This protocol is an invitation to external engineers to reproduce the local demonstration. It does not assert that an independent review has occurred. Only publish a person's results with their permission, identify their tested revision and environment, and preserve failures and skips alongside passes. Never include credentials, private data, or complete `data/` directories in a report.

## Setup and experiment

1. Clone the repository and record `git rev-parse HEAD`, the operating system, `node --version`, and `pnpm --version`. Use Node.js 24+ and pnpm 11.25.0. Install dependencies with `pnpm install`.
2. Run `pnpm demo:reliability`. It uses temporary SQLite databases and a separate local simulated provider. It deliberately terminates a worker after the simulated provider commits, then restarts the API. It does not contact a real payment provider or model.
3. Check that both printed JSON results show one external payment and a verified restart. The idempotent case should finish `SUCCEEDED` with two attempts; the unprotected case should stay `UNKNOWN` with one attempt and block replay. Investigate any mismatch instead of treating the expected output as a result.
4. Run `pnpm check` and record passed, failed, and skipped tests. PostgreSQL integration is optional and may be skipped without its configured instance; do not count a skip as a pass. For PostgreSQL prerequisites, see [Enterprise Runtime](ENTERPRISE-RUNTIME.md) and [multi-agent evidence](MULTI-AGENT-EVIDENCE.md).
5. Optionally follow the [local integration quickstart](INTEGRATION-QUICKSTART.md). Stop the services with Ctrl+C. The crash demo uses disposable temporary stores; the headless integration creates persistent local `data/` files.

## Report template

```text
Date and reviewer (or anonymous, with consent):
Commit SHA:
OS and architecture:
Node / pnpm versions:
Commands and exit codes:
Idempotent result / attempts / observed payments:
Unprotected result / attempts / observed payments:
pnpm check: passed / failed / skipped:
PostgreSQL version and configuration, or not run:
Unexpected behavior and steps to reproduce:
Permission to publish this report and attribution:
```

These are targeted tests of a local simulation, not proof of correctness for all schedules, real payment systems, or production deployments. Direct provider calls outside ActionLedger and provider idempotency expiry remain outside the demonstration's guarantees.
