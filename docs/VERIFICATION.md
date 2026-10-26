# Verification record

## Version 0.4.0 — 26 October 2026

Local pnpm check exited 0: strict TypeScript, zero-warning ESLint, formatting, 95 passing tests across nine files, and production build. The final test run completed in 40.61 seconds. No dependency on a paid API was added; the new workspace dependency shares core evidence types with the dashboard.

Eight new lab integration tests execute the real isolated harness, persistence/restart, deterministic seeded order/payloads, complete coverage, shared-DB concurrency, operator-only access, strict seed validation, deadlines, orderly shutdown, abandoned leases, malformed subprocess evidence, and offline CLI verification of valid/edited reports. Eight state-machine tests execute 1,280 seeded commands and check external-effect/approval invariants.

The CLI lab completed all eight experiments with 36/36 checks for seed 5409. The separate CLI verifier validated its JSON fingerprint and consistency. The compiled dashboard started and exercised its actual Run button, showed 8/8 completed cases and 36/36 checks, displayed naive baseline 2 vs guarded 1 payment, recomputed the fingerprint using Web Crypto, and downloaded an actual JSON evidence file. Reloading restored the saved run. Normal operator totals remained seven actions and five provider payments; lab simulations did not change those records.

The screenshots show the actual compiled interface with persisted synthetic experimental results. The earlier v0.3 CI results below do not establish v0.4 remote status; inspect the new release commit's CI separately.

No real provider, hosted model, OS sandbox, formal proof, trusted attestation or independent audit is claimed. A seed controls order/payloads only. Evidence fingerprints can be recomputed by an editor and are not signatures. Abrupt OS termination may leave synthetic temporary files.

## Version 0.3.0 — 26 October 2026

Verified locally on Windows with Node.js 24.19.0 and pnpm 11.25.0. pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false exited 0 with the installed cache. pnpm check exited 0: strict typecheck, zero-warning lint, Prettier, 79 passing tests across seven files, and the complete production build. Tests completed in 25.57 seconds.

The new coverage comprises six real @openai/agents 0.21.0 function-tool integration tests, sixteen failure/adapter tests (including two real five-second HTTP timeouts), and five scoped-credential tests. SDK tracing is disabled; no hosted model is invoked. Existing 52 regression tests also passed. SDK/Zod compatibility and the configurable local base URL are exercised using the actual package, not a mocked SDK.

pnpm demo:reliability exited 0. It ran actual process.exit(86) workers and reopened the API: protected SUCCEEDED, two attempts, one €10 external simulated payment; unprotected UNKNOWN, one attempt, one €10 payment, recovery refused. Stores were isolated and cleaned up.

The compiled pnpm start:headless launcher started the API/provider successfully using an isolated smoke-test directory. Health reported version 0.3.0, session bootstrap returned 404, and the scoped agent token received 403 for operator monitoring. No dashboard was started in this mode.

The earlier dashboard/browser checks below remain historical 0.2 evidence; there were no UI changes in 0.3. A real payment sandbox, hosted model run, independent security audit, OS sandbox and individually authenticated human roles remain unverified/unimplemented. Remote CI status must be checked separately on GitHub.

## Historical 0.2 verification

Version 0.2.0 verified locally on 26 October 2026 with Windows, Node.js 24.19.0, and pnpm 11.25.0.

| Check                                    | Actual result                                                    |
| ---------------------------------------- | ---------------------------------------------------------------- |
| pnpm install                             | Completed successfully; esbuild setup explicitly permitted       |
| pnpm install --frozen-lockfile --offline | Exit 0 using the installed local package cache                   |
| pnpm typecheck                           | Exit 0 across core, provider, API, and React                     |
| pnpm lint                                | Exit 0, zero warnings                                            |
| pnpm test                                | 52 tests passed across four test files                           |
| pnpm build                               | Exit 0; all TypeScript packages compiled and Vite assets emitted |
| pnpm dev                                 | Provider, API, and Vite started on loopback                      |
| pnpm start                               | Built provider/API/dashboard started on loopback                 |
| Production HTTP                          | Dashboard and health both HTTP 200 with CSP headers              |

## Automated reliability coverage

20 engine/provider tests cover immutable payloads, duplicate detection, validation, required approvals, final decisions, restart persistence, cached results, competing SQLite connections, active/expired leases, timeouts, lost responses, unsafe-retry blocking, stale-owner fencing, retry caps, provider key retention, intentionally unprotected duplicates, and receipt/payload binding.

16 HTTP/integration tests cover bearer tokens, Origin/Host restrictions, strict bodies/IDs, duplicates/conflicts, real child execution, process.exit after provider commit, API restart and recovery, unprotected UNKNOWN refusal, independent provider authentication, action/audit paging, the optional plain HTTP adapter, competing execution requests, and stalled-worker termination.

The protected process-crash regression asserts two requests, one €10 external payment, and a successful recovered ledger checkpoint. The unprotected regression asserts UNKNOWN, one attempt, one payment, and rejected execute/recover routes. Temporary test stores are removed after each test and do not use runtime data/.

## Browser and compiled-app checks

The local dashboard was visually inspected and exercised through its rendered controls: create action, explicit approval, normal execution, receipt/attempt inspector, both crash policies, durable rejection, duplicate submission, action search, status filter, CSV download trigger, audit search, architecture navigation, refresh, and dialog close. The production dashboard reloaded the same persisted actions and provider totals after stopping development and restarting the compiled app.

Both crash scenarios were also executed through the running compiled JavaScript worker: protected recovered to SUCCEEDED; unprotected returned UNSAFE_RETRY. Exactly two new external simulated payments were committed across these two distinct intents.

A production screenshot is supplied separately with the deliverable. Runtime records produced by manual verification remain only in the working data directory; they are excluded from the source distribution.

## Verification limits

No real payment provider or hosted AI model was contacted. The optional SDK wiring was not executed against the optional OpenAI package; its plain local HTTP adapter was tested. Browser checks were interactive desktop checks, not an automated cross-browser or mobile accessibility suite. CI is configured for Linux and Windows but was not run remotely. No penetration test or independent security audit is claimed. See SECURITY.md and README.md for the single-operator trust boundary and provider-dependent guarantees.

## Version 0.2 regression checks

Seven query/export tests verify complete-history search beyond 200 records, literal wildcard handling, combined status/search filters, stable page boundaries, query validation, complete filtered export, formula/quote/newline safety, and explicit refusal of over-10,000-row exports. Nine transport tests verify single-flight session bootstrap, structured correlation errors, session renewal only on a subsequent caller request, timeout ambiguity, no automatic mutation replay, invalid-response handling, CSV responses, bounded abort signals, and deliberate cancellation. Three additional HTTP tests cover pagination metadata, compatibility of the array API, filtered export authentication/headers, and strict query validation.

The upgraded browser interface was exercised with existing persistent data: server-side payee search, action inspector, filtered CSV download, five-row pages with next/previous navigation, oldest-first approval queue, creation and explicit rejection of a synthetic intent, and blocked recovery of an unprotected UNKNOWN action with a displayed request reference. No new provider payment was needed for those browsing/review checks.

Existing databases and decisions were preserved. Overview/provider metrics continued to reflect the existing independent stores. Source distribution excludes runtime stores and tokens. The export cap and live offset-pagination behavior are documented explicitly; this release makes no new external exactly-once claim.

The real development services were stopped during the browser check. The dashboard displayed Disconnected, retained its previous snapshot and UNKNOWN evidence, and offered an explicit Reconnect control instead of an endless initial spinner. Offline dependency verification used --config.confirmModulesPurge=false for the non-interactive Windows session; no new dependency was added.

The compiled 0.2.0 application also started successfully and reloaded the existing seven action records, five independent provider payments, and two deduplicated provider replays. The upgraded action registry rendered and queried those persistent records under the production CSP.
