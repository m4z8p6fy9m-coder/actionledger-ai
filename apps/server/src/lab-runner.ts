import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import {
  Ledger,
  chargeHttp,
  LAB_CASES,
  LabInput,
  LabEvidence,
  evidenceDigest,
  type LabCaseResult,
  type Payment,
  type Action,
} from "@actionledger/core";

/** The seed controls case order and payloads, not OS scheduling, timestamps or UUIDs. */
export async function runLaboratory(
  seed: number,
  onCase: (result: LabCaseResult) => void = () => {},
) {
  LabInput.parse({ seed });
  const startedAt = new Date().toISOString();
  let state = seed;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const order = [...LAB_CASES];
  for (let i = order.length - 1; i > 0; i--) {
    const j = random() % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const dir = await mkdtemp(join(tmpdir(), "actionledger-lab-"));
  const children = new Set<ChildProcess>();
  const token = randomBytes(32).toString("hex");
  const extension = extname(import.meta.url);
  let providerAddress = "";
  const launch = (name: string, args: string[] = []) => {
    const child = fork(
      fileURLToPath(new URL("./" + name + extension, import.meta.url)),
      args,
      {
        execArgv: extension === ".ts" ? ["--import", "tsx"] : [],
        env: {
          ...process.env,
          PROVIDER_TOKEN: token,
          PROVIDER_URL: providerAddress,
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };
  const results: LabCaseResult[] = [];
  try {
    const provider = launch("lab-provider", [
      join(dir, "provider.sqlite"),
      token,
    ]);
    const address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Lab provider startup timeout")),
        5000,
      );
      const fail = (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      };
      provider.once("error", fail);
      provider.once("exit", () => fail(new Error("Lab provider exited")));
      provider.once("message", (message) => {
        clearTimeout(timer);
        const data = message as { type?: string; address?: string };
        if (
          data.type !== "ready" ||
          !data.address?.startsWith("http://127.0.0.1:")
        )
          reject(new Error("Invalid lab provider address"));
        else resolve(data.address);
      });
    });
    providerAddress = address;
    const snapshot = async () => {
      const response = await fetch(address + "/payments", {
        headers: { authorization: "Bearer " + token },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error("Lab provider unavailable");
      return (await response.json()) as {
        paymentCount: number;
        requestCount: number;
        payments: { id: string; logicalKey: string }[];
      };
    };
    for (const id of order) {
      const began = Date.now();
      const mode =
        id === "unprotected-crash" || id === "unsafe-baseline"
          ? "unprotected"
          : "idempotent";
      const input: Payment = {
        idempotencyKey: "lab." + seed + "." + id,
        recipient: ["Alice", "Morgan", "Sam", "Jordan"][random() % 4],
        amountCents: 1000,
        currency: "EUR",
        providerMode: mode,
        description: "Isolated laboratory fixture",
      };
      const file = join(dir, id + ".sqlite");
      let ledger = new Ledger(file);
      let action: Action | undefined;
      const baseline = await snapshot();
      const checks: LabCaseResult["checks"] = [];
      const trace: LabCaseResult["trace"] = [];
      const check = (name: string, expected: unknown, actual: unknown) =>
        checks.push({
          name,
          expected: String(expected).slice(0, 300),
          actual: String(actual).slice(0, 300),
          pass: String(expected) === String(actual),
        });
      const capture = async (phase: string) => {
        const p = await snapshot();
        const a = action ? ledger.get(action.id) : undefined;
        trace.push({
          phase,
          status: a?.status ?? "BYPASS",
          attempts: a?.attempts ?? 0,
          payments: p.paymentCount - baseline.paymentCount,
          requests: p.requestCount - baseline.requestCount,
          receiptId: a?.receipt ? JSON.parse(a.receipt).id : null,
        });
      };
      const restart = () => {
        ledger.close();
        ledger = new Ledger(file);
      };
      const executeWorker = async (crash: boolean) => {
        if (!action) throw new Error("No action");
        const owner = randomUUID();
        const child = launch("worker", [
          file,
          action.id,
          owner,
          "false",
          String(crash),
        ]);
        const timeout = setTimeout(() => child.kill(), 10000);
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }).finally(() => clearTimeout(timeout));
        if (code !== 0)
          ledger.markUncertain(
            action.id,
            owner,
            "Lab observed execution worker exit " + code,
          );
        return code;
      };
      try {
        if (id === "unsafe-baseline") {
          await chargeHttp(address, token, input);
          await capture("First external payment, no durable ledger");
          await chargeHttp(address, token, input);
          await capture("Naive retry repeats the external effect");
          check(
            "Counterexample produces two payments",
            2,
            trace.at(-1)!.payments,
          );
          check(
            "Both unprotected requests reached the provider",
            2,
            trace.at(-1)!.requests,
          );
        } else {
          action = ledger.create(input).action;
          await capture("Intent durably recorded");
          if (id !== "approval-gate")
            ledger.decide(
              action.id,
              "approve",
              "Lab fixture (synthetic)",
              "Explicit operator-requested isolated test approval",
            );
          if (id === "protected-crash" || id === "unprotected-crash") {
            check(
              "Real worker terminates at failpoint",
              86,
              await executeWorker(true),
            );
            await capture("Worker exited after external commit");
            restart();
            await capture("Ledger connection reopened");
            check(
              "Crash survives restart as UNKNOWN",
              "UNKNOWN",
              ledger.get(action.id).status,
            );
            check(
              "No success receipt fabricated",
              null,
              ledger.get(action.id).receipt,
            );
            if (mode === "idempotent")
              await ledger.execute(
                action.id,
                (p) => chargeHttp(address, token, p),
                { recovery: true },
              );
            else {
              let blocked = false;
              try {
                await ledger.execute(
                  action.id,
                  (p) => chargeHttp(address, token, p),
                  { recovery: true },
                );
              } catch {
                blocked = true;
              }
              check("Unprotected replay rejected", true, blocked);
            }
            await capture(
              mode === "idempotent"
                ? "Explicit protected recovery"
                : "Unsafe recovery blocked",
            );
            check(
              "Exactly one observed external payment",
              1,
              trace.at(-1)!.payments,
            );
            check(
              "Expected durable final state",
              mode === "idempotent" ? "SUCCEEDED" : "UNKNOWN",
              ledger.get(action.id).status,
            );
            check(
              "Expected attempt count",
              mode === "idempotent" ? 2 : 1,
              ledger.get(action.id).attempts,
            );
          } else if (id === "lost-response" || id === "provider-error") {
            let failed = false;
            try {
              await ledger.execute(action.id, (p) =>
                chargeHttp(
                  address + (id === "lost-response" ? "/drop" : "/error"),
                  token,
                  p,
                ),
              );
            } catch {
              failed = true;
            }
            check("Transport reports an error", true, failed);
            await capture("Provider committed but no valid response arrived");
            check(
              "Error preserves uncertainty",
              "UNKNOWN",
              ledger.get(action.id).status,
            );
            restart();
            await ledger.execute(
              action.id,
              (p) => chargeHttp(address, token, p),
              { recovery: true },
            );
            await capture("Recovered with original key after restart");
            check(
              "One external effect despite two requests",
              1,
              trace.at(-1)!.payments,
            );
            check("Original key replayed", 2, trace.at(-1)!.requests);
            check(
              "Receipt recovered",
              "SUCCEEDED",
              ledger.get(action.id).status,
            );
          } else if (id === "approval-gate") {
            let blocked = false;
            try {
              await ledger.execute(action.id, (p) =>
                chargeHttp(address, token, p),
              );
            } catch {
              blocked = true;
            }
            check("Unapproved execution refused", true, blocked);
            ledger.decide(
              action.id,
              "reject",
              "Lab fixture (synthetic)",
              "Test durable veto",
            );
            restart();
            blocked = false;
            try {
              await ledger.execute(action.id, (p) =>
                chargeHttp(address, token, p),
              );
            } catch {
              blocked = true;
            }
            check("Rejection survives restart", true, blocked);
            await capture("Durable rejection blocks dispatch");
            check("No external request", 0, trace.at(-1)!.requests);
            check("No external payment", 0, trace.at(-1)!.payments);
          } else if (id === "payload-conflict") {
            let blocked = false;
            try {
              ledger.create({ ...input, amountCents: 2000 });
            } catch {
              blocked = true;
            }
            check("Changed amount cannot reuse intent key", true, blocked);
            await ledger.execute(action.id, (p) =>
              chargeHttp(address, token, p),
            );
            await capture("Only the approved immutable payload executes");
            const receipt = JSON.parse(ledger.get(action.id).receipt!);
            check("Approved amount preserved", 1000, receipt.amountCents);
            check("One payment", 1, trace.at(-1)!.payments);
          } else if (id === "concurrent-workers") {
            const codes = await Promise.all([
              executeWorker(false),
              executeWorker(false),
            ]);
            await capture("Two child workers competed for one claim");
            check("At least one worker completed", true, codes.includes(0));
            check("One admitted attempt", 1, ledger.get(action.id).attempts);
            check("One external request", 1, trace.at(-1)!.requests);
            check("One external payment", 1, trace.at(-1)!.payments);
          }
        }
      } catch (error) {
        check(
          "Scenario completes without harness error",
          "true",
          error instanceof Error ? error.message : "Harness failed",
        );
        if (!trace.length) await capture("Harness failure");
      }
      const final = await snapshot();
      const approval = action ? ledger.detail(action.id).approval : null;
      const result: LabCaseResult = {
        id,
        label: {
          "protected-crash": "Crash with provider idempotency",
          "unprotected-crash": "Crash without provider idempotency",
          "lost-response": "TCP response lost after commit",
          "provider-error": "HTTP 500 after provider commit",
          "approval-gate": "Durable human veto",
          "payload-conflict": "Immutable intent under mutation",
          "concurrent-workers": "Competing real worker processes",
          "unsafe-baseline": "Counterexample: naive retry duplicates",
        }[id],
        mode,
        durationMs: Date.now() - began,
        checks,
        trace,
        paymentIds: final.payments
          .filter((p) => p.logicalKey === input.idempotencyKey)
          .map((p) => p.id),
        payload: {
          recipient: input.recipient,
          amountCents: input.amountCents,
          idempotencyKey: input.idempotencyKey,
        },
        approval: approval
          ? {
              decision: String(approval.decision),
              actor: String(approval.actor),
            }
          : null,
      };
      ledger.close();
      results.push(result);
      onCase(result);
    }
    const evidence = LabEvidence.parse({
      formatVersion: 1,
      suiteVersion: "1",
      seed,
      startedAt,
      finishedAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      cases: results,
    });
    return { evidence, sha256: evidenceDigest(evidence) };
  } finally {
    for (const child of children) child.kill();
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once("close", () => resolve());
          }),
      ),
    );
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
if (
  process.send &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const seed = Number(process.argv[2]);
  try {
    const report = await runLaboratory(seed, (result) =>
      process.send?.({ type: "case", result }),
    );
    process.send({ type: "complete", report });
  } catch (error) {
    process.send({
      type: "failed",
      error: error instanceof Error ? error.message : "Lab failed",
    });
    process.exitCode = 1;
  }
}
