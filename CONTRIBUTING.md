# Contributing

Use Node 24+ and pnpm 11.25.0. Run pnpm install, pnpm test, pnpm typecheck, pnpm lint, and pnpm build. Format source with pnpm format. Test fixtures use fresh temporary databases, not data/.

## First contribution

1. Clone the repository, run `pnpm install --frozen-lockfile` and `pnpm demo:reliability`, then compare your output with the [reproduction checklist](docs/INDEPENDENT-REPRODUCTION.md).
2. For an unexpected result, use the [bug report template](.github/ISSUE_TEMPLATE/bug-report.md) with the commit, OS, exact commands and redacted output. If you independently reproduced the demo, the [reproduction report template](.github/ISSUE_TEMPLATE/independent-reproduction.md) also accepts successes, failures and skipped tests.
3. Pick a small, observable improvement: clarify documentation; add a failure position in [the lab protocol](docs/RELIABILITY-LAB.md); extend a regression in `tests/` or `packages/runtime/test/`; or reproduce an existing case on another supported platform. Discuss a change when its contract is uncertain.
4. For a defect, first add a focused regression demonstrating the problem, then implement the fix. For documentation-only changes, verify links and examples rather than adding a matching implementation test.
5. Run `pnpm check` before a pull request. Explain the change, exact checks and skips, and any altered safety assumptions. Python and PostgreSQL checks have additional prerequisites; list them honestly if not run.

See [verification history](docs/VERIFICATION.md) for optional Python and database commands. Tests and demos use temporary fixtures; never supply a shared or production database to fault or chaos experiments.

Keep transactions synchronous and short. Never hold a SQLite transaction across HTTP. Add regression tests for logical identity, approval, ownership, provider guarantees, and recovery changes. Use a real process exit test for checkpoint-gap changes.

Preserve these invariants:

1. One immutable payload per logical key.
2. Final durable human approval before every payment dispatch.
3. A worker checkpoints only its current RUNNING ownership token.
4. Timeout/interrupted dispatch means uncertainty, not definitive failure.
5. Unprotected UNKNOWN cannot replay, even on operator request.
6. Known success returns its saved result without external dispatch.
7. Meaningful state changes and human decisions are audited atomically.
8. Never claim SQLite transactions guarantee exactly-once external effects.

Keep real providers and SDK/model dependencies optional. Never commit runtime data or credentials. Preserve the project's independence from OpenAI.
