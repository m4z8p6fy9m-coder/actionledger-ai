# Contributing

Use Node 24+ and pnpm 11.25.0. Run pnpm install, pnpm test, pnpm typecheck, pnpm lint, and pnpm build. Format source with pnpm format. Test fixtures use fresh temporary databases, not data/.

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
