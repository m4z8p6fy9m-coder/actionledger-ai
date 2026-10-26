# Reliability lab protocol, version 1

## Purpose

Make the reliability claim inspectable through actual isolated executions. This lab is a reproducible engineering demonstration, not a formal proof, production benchmark, provider certification, or an OpenAI endorsement.

The dashboard and CLI execute the same runner. All payments are simulated. An operator starts a suite that explicitly creates synthetic fixture approvals in temporary stores. No action is created, approved or dispatched in the normal operator ledger.

## Process and storage boundaries

The API records a run in reliability_runs in its ledger database, then forks a bounded experiment runner. The runner creates a fresh OS temporary directory and starts a separate fault-capable provider process. Every scenario uses its own SQLite ledger; the provider owns a separate SQLite database. Actual execution workers perform the crash and contention experiments. The runner reopens ledger connections where restart behavior is tested.

The fault provider is a private lab executable. The normal simulated provider exposes no fault-control route. Neither executable contacts external services. IPC ready messages contain only a loopback address. Exported evidence contains no tokens, filesystem paths or normal operator records.

## Scenario matrix

| Scenario              | Expected observed behavior                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Protected crash       | Worker exits 86 after provider commit, ledger reopens UNKNOWN, original-key recovery returns one receipt across two requests |
| Unprotected crash     | Same failure gap; recovery refused, one payment, one attempt, UNKNOWN retained                                               |
| Lost TCP response     | Separate provider commits then destroys the socket; explicit protected recovery returns original receipt                     |
| HTTP 500 after commit | A failure status does not imply no effect; UNKNOWN followed by protected original-key recovery                               |
| Durable veto          | No approval means no dispatch; rejection survives reopening and prevents all requests                                        |
| Payload mutation      | Changing the amount under a bound key fails; only approved cents execute                                                     |
| Concurrent workers    | Two real child processes compete; one attempt and one external request admitted                                              |
| Naive retry baseline  | Deliberately bypass the ledger and repeat an unprotected provider call; two independent receipts demonstrate the hazard      |

The passed status means every recorded expected/actual comparison matched. In particular, the unsafe baseline passes when the duplicate effect is observed. It is never presented as safe execution.

## Reproducibility and evidence

Suite version 1 uses xorshift32 to shuffle all eight scenarios and choose synthetic recipients from a fixed list. Each payment is EUR 1000 cents. The seed is an integer from 1 to 2147483647. The deterministic portion is order and payload generation. Scheduling, UUIDs, creation times and measured durations are not deterministic.

JSON evidence includes format/suite versions, seed, runtime metadata, start/end times, complete scenarios, phase snapshots, checks, receipt IDs and synthetic approval attribution. SHA-256 covers the normalized JSON.stringify representation of the parsed evidence object. The envelope stores that digest separately. Both API export and the independent CLI verifier validate schema, complete distinct scenario coverage, fingerprint, and consistency of comparison flags. A report with a failed check is valid evidence of a failure and the CLI exits nonzero. A browser button recomputes the digest with Web Crypto.

Someone able to edit a report can recompute its hash. The digest detects accidental edits and verifies byte-level consistency of the normalized evidence; it does not prove author identity or truthful collection. SQLite and reports are not tamper-proof. Provider receipts are local simulated records, not externally signed statements.

## Persistence, concurrency and interruption

A SQLite partial unique index permits one RUNNING suite across API processes sharing the same database. Completed scenarios are persisted individually. The supervisor imposes a 60-second deadline; its lease expires five seconds later. Unknown or invalid subprocess messages fail closed. Reports are accepted only when final evidence matches the persisted case progress and requested seed. Export refuses partial or interrupted reports.

Orderly API shutdown kills its runner and records INTERRUPTED. An API crash may leave a RUNNING row until its lease expires; subsequent reads/start attempts mark it INTERRUPTED. There is no automatic rerun. An explicitly started new run has a fresh isolated environment. A disconnected runner's provider exits when its IPC parent disappears. Abrupt OS termination can leave synthetic temporary database files; this is not an operating-system sandbox or guaranteed crash-time garbage collection.

Historical listing returns the latest 20 runs; records are retained in the database. Completed evidence is exported by run UUID. Operators must manage disk retention; there is no delete/reset endpoint.

## REST

- POST /api/lab/runs with {"seed":5409}: 202 and durable RUNNING record, or 409 LAB_BUSY.
- GET /api/lab/runs: latest 20 persisted runs.
- GET /api/lab/runs/:id: durable progress and final report.
- GET /api/lab/runs/:id/evidence: validated JSON attachment; 409 REPORT_INCOMPLETE for partial runs.

All routes require the operator credential. Scoped agent credentials are denied. Seed/body validation is strict; callers cannot choose provider URLs, filesystem paths, worker files, scenario code or retry policies.

## Verification limits

Eight scenarios and seeded state exploration are finite observed tests. They do not establish correctness for all schedules, process/network failures, disk corruption, compromised hosts or real provider retention policies. The simulator retains idempotency keys indefinitely. No local transaction guarantees exactly-once external execution.
