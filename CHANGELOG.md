# Changelog

## 0.5.0 — 2026-10-26

- Add an optional pinned Python Agents SDK regression with real Runner/RunState approval persistence, process termination, and five offline scenarios.
- Add seeded fault campaigns, bounded delta debugging, portable counterexample recipes, and single-removal minimality checks.
- Add 11 fault-finder tests, 7 Python adapter tests, and Windows/Linux Python CI jobs.
- Add a maintainer brief separating SDK checkpoint recovery from external action uncertainty.
- Refresh repository presentation with independent branding and reproducibility links.

## 0.4.0 — 2026-10-26

- Add an interactive Reliability lab with eight real multi-process failure experiments, live durable progress and persisted run history.
- Compare an intentional naive-retry duplicate with the conservative ledger policy.
- Export schema-validated JSON evidence with provider receipt IDs, assertion results and SHA-256; verify independently in the browser or CLI.
- Isolate experiment ledgers and a separate fault-capable provider from normal operator actions. Bound concurrency with a SQLite unique index and supervise deadlines/interruption.
- Add CLI seeded experiments and 1,280-command state-machine invariant exploration.
- Document evidence/provenance limits and the difference between observed tests and a formal guarantee.

## 0.3.0 — 2026-10-26

- Test the real pinned OpenAI Agents SDK function tool offline; fix SDK/Zod compatibility and expose immutable-payload failures.
- Add HTTP commit/response-loss, malformed response, 500, actual timeout, pre-dispatch process exit, and concurrent recovery regression tests.
- Validate receipt structure and approved payload binding inside the engine for every provider adapter.
- Add optional headless API mode with separate scoped agent credentials and disabled operator-token bootstrap.
- Add an isolated assertion-backed crash/restart reproduction command, failure matrix, and reviewer/release guide.
- Extend Windows/Linux CI with formatting and the reproducible demo. No real payment sandbox or hosted model validation is claimed.

## 0.2.0 — 2026-10-26

### Improved

- Complete-ledger search, status filtering, deterministic sorting, and real pagination with result counts.
- Independent oldest-first human approval queue; pending work is no longer hidden by the latest-200 overview window.
- Consistent authenticated CSV export for all filtered matches, with an explicit 10,000-action cap and spreadsheet formula protection.
- Clearer operator interface: status tabs, readable tables, page sizes, timestamps, search clear control, and keyboard-accessible inspection.
- Reusable page, form, table, modal, pagination, transport, and polling modules.
- Bounded browser requests, coalesced session bootstrap, cancellation of superseded reads, retained snapshots on errors, and a rendering error boundary.
- Request correlation headers and request-scoped unexpected-error logs.
- Browser preferences can fail without invalidating a successfully persisted action intent.

### Compatibility and safety

- The original action-list array API remains available with its original default page size.
- Existing SQLite files and persisted approvals are preserved; no schema migration or data reset is required.
- No new dependency, cloud service, hosted API, automatic mutation replay, or unsafe recovery override.
- Provider-dependent execution guarantees and conservative UNKNOWN behavior are unchanged.

### Verification

52 automated tests across engine, provider, real process crashes, HTTP security, full-history queries, CSV safety, and browser transport. See docs/VERIFICATION.md for the actual check record and limits.

## 0.1.0 — 2026-10-25

Initial offline action engine, separate persistent provider, human approval workflow, crash lab, dashboard, API, and optional SDK adapter.
