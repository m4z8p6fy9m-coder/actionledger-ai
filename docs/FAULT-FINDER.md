# Seeded fault campaigns and minimized counterexamples

The finder exercises the real ActionLedger core and a separate persistent simulated provider database in disposable directories. Restart commands close and reopen both stores. It never opens the application's normal records.

    pnpm faults --seed 5409 --cases 24 --provider-mode unprotected
    pnpm faults --seed 5409 --cases 24 --provider-mode idempotent
    pnpm faults --target unsafe-baseline --seed 5409 --expect-violation --output counterexample.json
    pnpm faults replay counterexample.json

The underlying Node CLI for a normal campaign exits 0 if no invariant violation was observed, 2 if one was observed, and 1 for invalid input or execution failure. The explicit --expect-violation flag reverses the campaign expectation for calibration. Replay still exits 2 for the failing counterexample; pnpm reports a failed script and may normalize its outer exit code. Output files are created exclusively, so existing evidence is not overwritten. A failing campaign writes a portable recipe; a passing campaign writes its summary.

## Search and oracle

Seeded noise includes creation, exact duplicates, payload conflicts, approvals, rejections, execution, recovery, and restarts across three fixed synthetic intents. Every generated case contains a known crash-gap template. This is a calibrated adversarial campaign, not unconstrained bug discovery.

Fault locations are before dispatch, after the provider commits, and before local success checkpointing. Here they are injected exceptions around real execution callbacks. For actual process termination and HTTP transport faults, use the separate Reliability lab and Python regression.

The oracle checks duplicate external payments per intent, payment without a durable approval, redispatch after cached success, and redispatch of unprotected UNKNOWN. The deliberately unsafe comparison keeps approval and a local success cache but omits the uncertainty guard. It is a positive control, not a production execution mode or an SDK implementation.

## Reduction

Delta debugging removes command chunks while preserving the exact violation signature, then verifies individual command removal. A report sets oneMinimal only when every remaining command has been checked and removing any one loses that signature. This is not a globally shortest sequence. A bounded replay budget may finish without establishing minimality; the report says so explicitly.

For seed 5409, the unsafe unprotected comparison reduces to:

1. Create intent.
2. Approve intent.
3. Execute; provider commits and result is lost.
4. Recover; a second payment is observed.

The restart command is removable because lost external evidence is sufficient to reproduce the hazard. The original generated sequence still tests persistence with a restart.

Strict Zod schemas allow only bounded fixture operations; recipes cannot supply code, URLs, SQL, or application database paths. Cases are limited to 100, commands to 160 per recipe, and reduction replays to 512. No violations observed in a bounded campaign is test evidence, not a safety proof.
