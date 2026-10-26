# Multi-agent reliability: local evidence and operating limits

This document describes a reproducible local demonstrator, not a production certification or an independent security audit. ActionLedger AI is independent of OpenAI and Anthropic.

## Architecture and state

```mermaid
flowchart LR
  A[Host A and MCP client] --> GA[Gateway A]
  B[Host B and MCP client] --> GB[Gateway B]
  GA --> DB[(Shared runtime ledger)]
  GB --> DB
  DB --> L[Unique semantic-hash lock]
  GA --> P[External connector]
  DB --> R[Read-only recovery]
```

The host binds each intent to an agent ID and a hash of canonical JSON containing the host's prompt hash and asset ID. A unique database row serializes acquisition for the same hash; a separate durable block and audit entry records a rejected _different_ intent. The underlying blocked intent stays READY with zero attempts, while MCP reports LOCKED. Two agents racing for the **same intent ID** must not create a block against the winning intent; the loser receives a collision error, and the winner may still claim the action.

The owner progresses READY → RUNNING → SUCCEEDED, UNKNOWN, or REJECTED. Transactional execution claims increment a fencing number; a late owner cannot checkpoint over a newer claim. A lock can transfer to a different intent only when its owner is SUCCEEDED **and** its minimum window has elapsed. UNKNOWN, a timeout, an expired execution lease, or rejection is not evidence of success and does not release the lock. A new explicit request is necessary for transfer; sequential effects remain possible.

## Chosen lock contract and tenant boundaries

We retain the existing narrow host-defined collision group (the identity-oriented option A), rather than introducing a new resource-and-conflict-group contract or changing existing persisted keys. Its exact identity is the canonical pair `(promptHash, assetId)`, not the complete canonical intent. The pair does not include the intent ID, operation, connector or payload; equal pairs can therefore over-block different actions, and different prompt hashes can under-block actions on the same resource. A prompt hash is not proof of semantic equality. This is **not** a guarantee that all concurrent actions on an asset, or all semantically identical intents, share a lock. Hosts must consistently and trustworthily choose the pair.

The collision group is distinct from the ledger's immutable intent fingerprint and provider key, from the fencing token protecting ledger checkpoints, and from external provider-enforced idempotency. Fencing prevents an expired local owner from overwriting a newer checkpoint; it cannot retract an already dispatched external request. Connector evidence and callers of low-level store methods are trusted: `store.finish` does not independently authenticate a provider receipt. Provider idempotency depends on the provider and its retention policy.

The shared lock table has **no tenant column or tenant-aware authorization**. The manifest namespace is not part of the lock hash. Two tenants using the same unqualified asset ID and prompt hash in the same database collide, while the same asset with different prompt hashes does not collide. A host may use an unambiguous canonical tenant-qualified asset ID such as the JSON encoding of `[tenantId, assetId]`, or operate separate databases. This only scopes lock keys; it does not provide authentication, tenant isolation for other tables or protection against a malicious host. Global intent IDs, trusted host bindings, access controls and provider credentials still require independent tenant isolation.

PostgreSQL uses a unique constraint and transactional INSERT/ON CONFLICT; SQLite uses the same uniqueness rule inside BEGIN IMMEDIATE transactions. The lock's minimum time is calculated from the calling host's clock, so cross-host clock skew can affect the minimum duration. A missing response, elapsed lease, UNKNOWN or REJECTED state never justifies automatic unlock.

## Experiments

`pnpm demo:multi-agent` creates disposable fixtures using two independent SQLite connections and prints the demo. For the same-intent race, it launches two independent Node host processes, each with its own database connection, and releases them concurrently. The distinct-intent SQLite acquisition runs sequentially inside the parent because synchronous `node:sqlite` calls in one event loop cannot demonstrate simultaneous transactions. The demo also uses two MCP clients, simulated effects, actual ledger records and audit entries. With `TEST_DATABASE_URL`, the same-intent process race uses PostgreSQL and the distinct-intent race also uses two independent PostgreSQL driver pools concurrently. This is a local process and database test, not a network partition test.

The run asserts: the same intent with two agents has one owner and the winner can claim; different intents on one hash conflict and the loser cannot execute; a different asset and a different prompt hash acquire independently; stale owner checkpoints fail; an unverified outcome stays UNKNOWN; confirmed success and the minimum-window boundary permit explicit transfer; and an injected database exception at the lock INSERT causes a gateway error and no dispatch. Different prompt hashes for one asset intentionally produce different keys: this guard does **not** serialize by asset alone. Tenant-qualified test asset IDs produce separate keys; equal unqualified IDs collide across conceptual tenants.

The demonstration uses a simulated connector and synthetic decisions, not live providers or authenticated human identities. The database error is injected into the actual transaction wrapper at the conflict check; it is not a network partition. The separate chaos test exercises interrupted PostgreSQL sessions and a mocked Stripe provider.

### Run locally

Requires Node 24, pnpm 11.25, installed dependencies and a writable `work/` directory. The SQLite files and PostgreSQL fixture rows are left in place for inspection; do not use a production or shared database.

```sh
pnpm install
pnpm demo:multi-agent
# With a running disposable local PostgreSQL database:
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB ACTIONLEDGER_PROOF_DISPOSABLE=YES pnpm demo:multi-agent
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB pnpm test:postgres
BENCH_OUTPUT=work/guard-sqlite.json pnpm bench:guard
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB ACTIONLEDGER_PROOF_DISPOSABLE=YES BENCH_OUTPUT=work/guard-postgres.json pnpm bench:guard
```

PowerShell: set the same variables using `$env:NAME='value'` before each command. The benchmark refuses to overwrite an existing output file. PostgreSQL must be installed and running separately; no cloud service or Docker is required. SQLite uses the Node built-in driver.

## Observed local verification

On 2026-10-26, the isolated SQLite demo and PostgreSQL demo passed. Two separate host processes concurrently contended for the same intent in both adapters; the PostgreSQL run also raced two distinct intents through independent pools. The PostgreSQL integration test passed separately against a disposable PostgreSQL 18.4 instance. The local mock-Stripe chaos run reported 24 actions, 24 POSTs, 24 simulated payments and 24 UNKNOWN outcomes.

A local `pnpm check` run passed 143 tests and skipped the PostgreSQL-specific test because `TEST_DATABASE_URL` was not configured in that run; its standalone run is noted above. Python Ruff, strict mypy and 13 unit tests passed, as did five offline Python SDK scenarios. These observations apply to this workspace and do not establish that remote CI or any external deployment has run the new code.

## Guard microbenchmark

Environment: Windows 10.0.19045 x64; Node v24.19.0; AMD Ryzen 5 2600 Six-Core Processor, 12 logical CPUs; SQLite 3.53.3; PostgreSQL 18.4 on loopback. SQLite used one synchronous driver/connection. PostgreSQL used two driver instances, each backed by a pool of up to ten connections; 16 concurrent requests may use more than two backend connections. Both benchmark processes ran on the same machine at overlapping times and may have competed for resources. No warm-up or dedicated performance isolation was performed.

Each trial has 48 approved fixture intents, three repetitions at concurrency 1, 4 and 16. Only guard acquisition is timed; registration, approval, agent execution, provider calls and the full MCP workflow are excluded. Conflict trials use one hash; independent trials use distinct hashes. The table selects the median-throughput repetition in each group and reports that repetition's latency percentiles in milliseconds. Accepted/rejected counts refer to that 48-request trial. Raw samples, each repetition, timestamp and environment are preserved in [SQLite JSON](evidence/guard-benchmark-sqlite-final.json) and [PostgreSQL JSON](evidence/guard-benchmark-postgres-final.json).

| DB       | Concurrency | Scenario    | Requests/s | p50 ms | p95 ms | p99 ms | Accepted/rejected |
| -------- | ----------: | ----------- | ---------: | -----: | -----: | -----: | ----------------: |
| sqlite   |           1 | conflict    |      502.2 |   2.03 |   2.62 |   3.27 |              1/47 |
| sqlite   |           1 | independent |      717.4 |   1.10 |   2.22 |   3.61 |              48/0 |
| sqlite   |           4 | conflict    |      536.7 |   7.25 |   9.28 |  10.47 |              1/47 |
| sqlite   |           4 | independent |      673.0 |   5.85 |   7.53 |   8.11 |              48/0 |
| sqlite   |          16 | conflict    |      457.8 |  32.39 |  40.24 |  41.16 |              1/47 |
| sqlite   |          16 | independent |      586.3 |  23.37 |  29.90 |  32.59 |              48/0 |
| postgres |           1 | conflict    |      631.4 |   1.44 |   2.12 |   2.37 |              1/47 |
| postgres |           1 | independent |      886.2 |   1.04 |   1.63 |   2.13 |              48/0 |
| postgres |           4 | conflict    |     1107.4 |   3.29 |   5.90 |   9.42 |              1/47 |
| postgres |           4 | independent |     2343.4 |   1.46 |   3.53 |   3.70 |              48/0 |
| postgres |          16 | conflict    |      843.8 |  15.53 |  33.30 |  35.15 |              1/47 |
| postgres |          16 | independent |     3155.4 |   5.05 |   6.20 |   6.36 |              48/0 |

These are observations from one local run, not capacity estimates, a production SLA or hyperscale performance claims. Lock conflicts include durable collision-audit writes. SQLite measurements serialize asynchronous requests through one synchronous connection; they do not measure concurrent SQLite processes.

## UNKNOWN: safe operator procedure

1. Pause further attempts for the affected asset. Preserve the original intent ID, immutable provider key, action status, fence, audit records and provider reference; use access-controlled read-only tools.
2. Consult the provider dashboard and authenticated provider evidence. A missing search result or elapsed timeout is not proof of failure. Never issue a fresh payment or force a retry solely to clear a lock.
3. Where the configured connector supports authoritative read-only reconciliation, let the existing recovery loop verify the result. Generic REST and MCP connectors may have no authoritative lookup and can remain UNKNOWN indefinitely.
4. If evidence cannot be verified by the implemented connector, escalate to an operator with provider-specific procedures; keep the lock and intent blocked. There is currently no supported general-purpose manual resolution or safe administrative unfreeze API. Do not edit ledger tables or manufacture a SUCCEEDED result to unlock them. A separately reviewed remediation and operator decision are required.

## Limits and trust

The guard is optional. Direct calls before a block exists, unguarded gateways, separate databases and external actors can bypass it. Host agent IDs and semantic hashes are trusted configuration, not authenticated distributed identities. Exact-hash equality is not semantic similarity or a vector clock. Atomic local transactions cannot guarantee exactly-once external effects. The system requires durable database configuration and external provider idempotency, where supported. Distinct SQLite connections inside one synchronous event loop are not a realistic multi-process contention benchmark.
