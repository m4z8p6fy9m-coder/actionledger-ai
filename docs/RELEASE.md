# Release checklist and reviewer guide

## Reproduce locally

Use Node.js 24+ and the pnpm version pinned in package.json. Run pnpm install --frozen-lockfile, pnpm check, and pnpm demo:reliability. The last command asserts actual process crashes and restart behavior in disposable stores.

## What to review first

- packages/core/src/index.ts: immutable intent, final approval, ownership claim, uncertainty and receipt validation.
- apps/server/src/app.ts: scoped authorization, disabled headless bootstrap, child supervision and owner-fenced failure handling.
- tests/reliability.test.ts: real HTTP failure matrix and competing/late workers.
- tests/sdk.test.ts: actual SDK function-tool invocation without model or tracing.
- docs/FAILURE-MATRIX.md and SECURITY.md: explicit provider and identity assumptions.

## Publication hygiene

Publish source and lockfile only. Exclude data, SQLite/WAL/SHM files, environment files, tokens, node_modules, temporary test files and generated output. The MIT license and OpenAI independence statement must stay visible. Use synthetic issue reports only. Do not post to upstream maintainers automatically.

GitHub already offers source archives, and the existing v0.5.0 pre-release has a source ZIP and checksum. These are source distributions: users still need Node.js, pnpm, registry access and `pnpm install --frozen-lockfile`. Creating another ZIP would not remove those prerequisites, so no new package workflow or download artifact is proposed. A future binary distribution would need clean-machine tests on each advertised platform and an independently reviewed exclusions/checksum process before publication. The root package remains private and is not an npm SDK.

v0.5.0 is marked pre-release and predates the optional runtime on the current branch; this is consistent with the project's experimental scope. An older release archive does not contain newer main-branch runtime features. The repository root still declares version `0.5.0` while the private optional runtime package declares `0.6.0`; the latter is unreleased workspace code, not a published SDK version. Do not silently replace release artifacts or imply the latest branch is that released version.

CI runs verification on Linux and Windows for pushes and pull requests. A configured workflow is not evidence of a passing remote run. Report the actual release commit and job result. Tag a release only after checks pass. Local verification does not establish production suitability or provider-independent exactly-once execution.

## Next external validation

A real payment sandbox integration is future work requiring separately configured test credentials and a provider-specific recovery horizon. Do not substitute the simulator's infinite key retention for a real provider guarantee. Hosted model evaluation, multi-user identity, independent security review and deployment hardening remain outside this reference release.
