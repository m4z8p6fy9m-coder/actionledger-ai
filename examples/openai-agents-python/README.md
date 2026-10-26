# Offline Python Agents SDK regression

This optional example uses pinned openai-agents 0.24.0 with real Runner, tool approvals, RunState serialization/restoration, and actual process termination. A local deterministic Model replaces hosted inference. The default Node application and pnpm test do not need Python.

From the repository root:

    pnpm install
    pnpm python:setup
    pnpm demo:python
    pnpm test:python
    pnpm lint:python

Requirements: Node 24+, pnpm 11.25, Python 3.11–3.13, uv. uv.lock pins transitive dependencies. Installation needs registry access; the regression itself needs only loopback networking. Tracing is disabled and OPENAI_API_KEY is removed from child environments.

ledger_tool.py contains the narrow HTTP adapter. The application owns intent IDs, credentials, and provider policy; these are not tool arguments. The adapter cannot approve actions and never retries uncertain writes. regression.py contains the real SDK flow. scripts/python-repro.mjs owns isolated stores, the separate payment provider, operator decisions, and observable assertions.

The unsafe comparison must create two payments. The ledger checkpoint and protected gap cases must create one. Unprotected uncertainty must remain UNKNOWN with one payment and no second provider request. The rejected decision must produce no payment.

See [maintainer brief](../../docs/MAINTAINER-BRIEF.md) for the exact checkpoint boundaries and limitations. This is independent of OpenAI and does not claim to fix an SDK vulnerability.
