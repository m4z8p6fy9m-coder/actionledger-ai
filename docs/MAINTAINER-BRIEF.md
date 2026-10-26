# Maintainer brief: external tool effects across an agent checkpoint gap

ActionLedger AI is independent of OpenAI. This is a reproducible integration experiment for the failure window discussed in [Agents Python issue #5409](https://github.com/openai/openai-agents-python/issues/5409), not a claim of a new SDK vulnerability or a proposed mandatory SDK dependency.

## What to inspect

The optional Python fixture uses the actual openai-agents 0.24.0 package, Agent, Runner, function_tool(needs_approval=True), and serialized RunState. A deterministic local Model emits the payment tool call. No hosted inference, API key, tracing service, or external runtime network is used. The fixture process rejects non-loopback socket connections through a Python audit hook; this is a test guard, not an OS security boundary.

The host records a synthetic operator decision separately in the ledger. The SDK decision and ledger authorization are independent gates. Both persist before execution. The payment provider runs in a separate process with its own SQLite file.

| Scenario               | Fault / resumed behavior                                                                            | Expected payments |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ----------------- |
| Unsafe comparison      | Provider commits; Python exits before SDK checkpoint; resume repeats tool                           | 2                 |
| Ledger checkpoint      | Ledger commits success; Python exits before SDK checkpoint; cached receipt returned                 | 1                 |
| Protected engine gap   | Provider commits; execution worker exits before ledger success; recovery uses original provider key | 1                 |
| Unprotected engine gap | Same gap without provider deduplication; resumed tool reports UNKNOWN and blocks dispatch           | 1                 |
| Rejected decision      | Reconstructed SDK state retains rejection; ledger veto persists                                     | 0                 |

The two gap cases also terminate the Python process after the engine has returned UNKNOWN. They test both checkpoint layers. The process exit is real os._exit(86), not merely an exception. Receipts and payment counts are read from the separate provider, not inferred from ledger success.

## Reproduce

Install Node 24+, pnpm 11.25, Python 3.11–3.13, and uv. Initial dependency installation needs registry access.

    pnpm install
    pnpm python:setup
    pnpm demo:python --output python-evidence.json
    pnpm test:python
    pnpm lint:python

The report contains SDK version, process exit codes, observed provider requests/payments, final ledger states, and tool outputs. Output paths must not exist. Runtime execution is local after installation.

For a four-command counterexample with the deliberately unsafe comparison:

    pnpm faults --target unsafe-baseline --seed 5409 --expect-violation --output counterexample.json
    pnpm faults replay counterexample.json

The underlying replay CLI exits 2 when it observes the duplicate (pnpm reports a failed script). The first command expects that failure and exits 0. See [fault-finder scope](FAULT-FINDER.md).

## Potential integration boundary

An application assigns a durable business intent ID before running the agent. The tool accepts model-provided payment arguments but closes over that host-owned ID and provider policy. It submits immutable intent to the ledger, returns cached success, waits for external operator approval, and dispatches only through guarded execution. RunState remains responsible for agent progress; the ledger remains responsible for action uncertainty.

A small upstream-facing contribution could be a documentation recipe or regression fixture explaining these separate checkpoints. This project does not patch the SDK or require that the SDK implement a payment ledger. Approving a tool call does not prove its external effect was checkpointed.

## Limits

Local database transactions do not atomically commit an external payment. Duplicate prevention across an uncertain gap depends on a provider honoring the same key and payload within its retention policy. The simulator retains keys indefinitely; real providers need explicit capability and expiry handling. Unprotected UNKNOWN requires external reconciliation and is never automatically retried.

The optional adapter is a focused example, not a general Python client. The fixtures cover non-streamed single-tool runs and synthetic EUR payments. They do not certify real payment processors, malicious-model isolation, distributed consensus, or all possible schedules. No claim is made that these techniques are novel. Nothing has been submitted to OpenAI by this change.

## Observed local verification

On Windows with Node 24 and Python 3.11.9:

- pnpm check: 106 tests across 10 files passed; TypeScript, ESLint, Prettier, and production build passed.
- pnpm test:python: 7 adapter tests passed.
- pnpm lint:python: Ruff lint and format checks passed.
- pnpm demo:python: all 5 actual SDK scenarios passed, with observed payment counts 2 / 1 / 1 / 1 / 0.
- Seed 5409, unsafe comparison: 20 generated commands reduced to 4, 26 replay attempts, single-removal minimality verified.
- Seed 5409, guarded unprotected campaign: 24 cases and 448 commands completed without an observed invariant violation.

The final error-handling hardening was followed by a second successful run of all 11 fault-finder tests and ESLint. Cross-platform CI jobs are configured, but these new changes have not yet been executed on GitHub. These are bounded observations, not a certification.
