# ActionLedger AI: launch and reproduction brief

This is a draft for a maintainer to adapt and share. It is not an announcement
that has been posted or evidence of independent adoption.

## One-line description

ActionLedger AI is an independent, local-first reliability lab for exploring
crash recovery, approval and idempotency for external actions made by AI agents.

## Short introduction

What happens when an agent executes a payment, but its process crashes before
the result is saved? A blind retry can cause a second external effect.

ActionLedger records the uncertain outcome. Its offline demo uses a separate
simulated provider: explicit recovery reuses the original key when the provider
enforces idempotency; without that protection, the action remains `UNKNOWN` and
replay is blocked. Run the experiment and inspect the ledger and provider data:

```sh
git clone https://github.com/m4z8p6fy9m-coder/actionledger-ai.git
cd actionledger-ai
pnpm install --frozen-lockfile
pnpm demo:reliability
```

Requires Node.js 24+ and pnpm 11.25.0. Dependency installation requires network
access; the experiment runs locally without an API key. [Watch the recorded
dashboard demo](videos/actionledger-live-demo-final.mp4), or see the
[developer tour](DEVELOPER-DEMO.md) for the UI and integration example.

## What to discuss

- What evidence should an operator require before resolving an uncertain action?
- How should a real provider's key scope, concurrency and expiration be tested?
- Where did the quickstart or the trust boundaries need clearer explanations?

The [strategy comparison](STRATEGY-COMPARISON.md) includes an unsafe positive
control and describes where scenarios are not matched. The simulated provider
retains keys indefinitely; this is not a test of real key expiration.

## Suggested 30-second demo structure

Use the [existing recording](videos/actionledger-live-demo-final.mp4) as a
visual reference; this is an outline, not a claim that a new video was recorded.

| Time    | Show                                                   | Explain                                                                          |
| ------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 0–6 s   | Create and approve the simulated €10 action            | A human approves a specific intent.                                              |
| 6–13 s  | Execute and crash after the simulated provider commits | The external effect can outlive the agent's checkpoint.                          |
| 13–21 s | Inspect the ledger and provider evidence               | The ledger records `UNKNOWN`; the provider shows a simulated receipt.            |
| 21–30 s | Compare protected recovery with unprotected replay     | Same-key recovery requires provider idempotency; otherwise replay stays blocked. |

## Invitation to an independent tester

> Would you try this offline agent-action recovery demo on your own machine?
> Please follow the [reproduction checklist](INDEPENDENT-REPRODUCTION.md), record
> your commit, OS, Node/pnpm versions, commands, outcomes and any failures or
> skipped tests, and tell us where the setup was confusing. Do not share tokens
> or your `data/` directory. We will only publish your results with your consent.

The [reproduction report template](../.github/ISSUE_TEMPLATE/independent-reproduction.md)
can be used to submit actual results. This project currently makes no claim that
independent testing has happened.

## Boundaries

This is an experimental, independent open-source project; it is not affiliated
with or endorsed by OpenAI. A local ledger cannot guarantee exactly-once effects
in an external system. The demo uses simulated payments; real Stripe behavior
and a production security assessment are not established by these experiments.
The optional runtime has a separate ledger and its own recovery policy.
