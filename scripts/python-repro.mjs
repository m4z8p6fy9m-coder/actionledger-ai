/** Five actual SDK/RunState scenarios. Disposable stores, separate provider, no API key. */
import assert from "node:assert/strict";
import { spawn, fork } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../apps/server/src/app.ts";

const project = resolve("examples/openai-agents-python");
const python = join(
  project,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
try {
  await access(python);
} catch {
  throw new Error(
    "Python fixture is not installed. Run pnpm python:setup first.",
  );
}
const dir = await mkdtemp(join(tmpdir(), "actionledger-python-sdk-"));
const operator = randomBytes(32).toString("hex");
const agent = randomBytes(32).toString("hex");
const providerToken = randomBytes(32).toString("hex");
const children = new Set();
let server;
let provider;
const traces = [];
try {
  provider = fork(
    fileURLToPath(
      new URL("../apps/server/src/lab-provider.ts", import.meta.url),
    ),
    [join(dir, "provider.sqlite"), providerToken],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  const providerUrl = await new Promise((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error("Python fixture provider startup timeout")),
      10000,
    );
    provider.once("error", rej);
    provider.once("message", (m) => {
      clearTimeout(timer);
      if (m.type !== "ready" || !m.address.startsWith("http://127.0.0.1:"))
        rej(new Error("Invalid provider handshake"));
      else res(m.address);
    });
  });
  server = await buildServer({
    file: join(dir, "ledger.sqlite"),
    apiToken: operator,
    agentToken: agent,
    sessionBootstrap: false,
    providerToken,
    providerUrl,
  });
  const apiUrl = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const providerState = async () => {
    const response = await fetch(providerUrl + "/payments", {
      headers: { authorization: "Bearer " + providerToken },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const runPython = (phase, scenario, folder) =>
    new Promise((res, rej) => {
      const child = spawn(
        python,
        [join(project, "regression.py"), phase, scenario, folder],
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: undefined,
            OPENAI_AGENTS_DISABLE_TRACING: "1",
            PYTHON_AGENT_TOKEN: agent,
            PYTHON_API_URL: apiUrl,
            PYTHON_PROVIDER_URL: providerUrl,
            PYTHON_PROVIDER_TOKEN:
              scenario === "baseline"
                ? providerToken
                : "not-granted-to-guarded-tools",
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      children.add(child);
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => {
        stdout = (stdout + b).slice(-20000);
      });
      child.stderr.on("data", (b) => {
        stderr = (stderr + b).slice(-20000);
      });
      const timer = setTimeout(() => child.kill(), 30000);
      child.once("error", rej);
      child.once("close", (code) => {
        clearTimeout(timer);
        children.delete(child);
        if (code !== 0 && code !== 86) {
          rej(
            new Error(
              "Python " + phase + "/" + scenario + " failed: " + stderr,
            ),
          );
          return;
        }
        res({
          code,
          result: stdout.trim()
            ? JSON.parse(stdout.trim().split("\n").at(-1))
            : null,
        });
      });
    });
  for (const scenario of [
    "baseline",
    "ledger-checkpoint",
    "protected-gap",
    "unprotected-gap",
    "rejected",
  ]) {
    const folder = join(dir, scenario);
    await mkdir(folder);
    const before = await providerState();
    let id;
    if (scenario !== "baseline")
      id = server.ledger.create({
        idempotencyKey: "agent.python." + scenario,
        recipient: "Alice",
        amountCents: 1000,
        currency: "EUR",
        providerMode:
          scenario === "protected-gap" ? "idempotent" : "unprotected",
        description: "Python SDK regression fixture",
      }).action.id;
    const prepared = await runPython("prepare", scenario, folder);
    assert.equal(prepared.code, 0);
    assert.equal(prepared.result.interruptions, 1);
    assert.equal((await providerState()).requestCount, before.requestCount);
    const decision = await runPython(
      scenario === "rejected" ? "reject" : "approve",
      scenario,
      folder,
    );
    assert.equal(decision.code, 0);
    if (id)
      server.ledger.decide(
        id,
        scenario === "rejected" ? "reject" : "approve",
        "Regression operator (synthetic)",
        "Explicit isolated SDK fixture decision",
      );
    const approvedBytes = await readFile(join(folder, "approved.json"));
    const approvedHash = createHash("sha256")
      .update(approvedBytes)
      .digest("hex");
    for (const secret of [operator, agent, providerToken])
      assert.ok(
        !approvedBytes.includes(secret),
        "SDK state must not embed transport credentials",
      );
    let crash = null;
    if (scenario !== "rejected") {
      crash = await runPython("crash", scenario, folder);
      assert.equal(
        crash.code,
        86,
        "Fixture must terminate with a real os._exit(86)",
      );
      assert.equal(
        (await providerState()).paymentCount - before.paymentCount,
        1,
      );
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(folder, "approved.json")))
          .digest("hex"),
        approvedHash,
        "Crash must leave original approved SDK state unchanged",
      );
      if (id)
        assert.equal(
          server.ledger.get(id).status,
          scenario === "ledger-checkpoint" ? "SUCCEEDED" : "UNKNOWN",
        );
    }
    const resumed = await runPython("resume", scenario, folder);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.result.interruptions, 0);
    const after = await providerState();
    const expected =
      scenario === "baseline" ? 2 : scenario === "rejected" ? 0 : 1;
    assert.equal(after.paymentCount - before.paymentCount, expected);
    const action = id ? server.ledger.get(id) : null;
    if (action)
      assert.equal(
        action.status,
        scenario === "unprotected-gap"
          ? "UNKNOWN"
          : scenario === "rejected"
            ? "REJECTED"
            : "SUCCEEDED",
      );
    if (scenario === "protected-gap") {
      assert.equal(after.requestCount - before.requestCount, 2);
      assert.equal(action.attempts, 2);
    }
    if (scenario === "unprotected-gap") {
      assert.equal(after.requestCount - before.requestCount, 1);
      assert.equal(action.attempts, 1);
      assert.ok(
        resumed.result.toolOutputs.some(
          (t) => JSON.parse(t).replayBlocked === true,
        ),
      );
    }
    traces.push({
      scenario,
      sdkVersion: prepared.result.sdkVersion,
      approvalInterruption: true,
      crashExitCode: crash?.code ?? null,
      approvedStateUnchangedAfterCrash: crash ? true : null,
      payments: after.paymentCount - before.paymentCount,
      requests: after.requestCount - before.requestCount,
      ledgerStatus: action?.status ?? "NO_LEDGER",
      attempts: action?.attempts ?? null,
      toolOutputs: resumed.result.toolOutputs,
      paymentIds: after.payments.slice(0, expected).map((p) => p.id),
    });
    console.log(
      "PASS " +
        scenario +
        ": " +
        expected +
        " payment(s), " +
        (action?.status ?? "unsafe baseline"),
    );
  }
  const report = {
    formatVersion: 1,
    pythonSdk: "openai-agents==0.24.0",
    hostPlatform: process.platform,
    model: "local deterministic Model; no hosted inference",
    traces,
  };
  const output = process.argv.indexOf("--output");
  if (output >= 0) {
    const file = process.argv[output + 1];
    if (!file) throw new Error("--output requires a filename");
    await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
    console.log("Evidence written: " + file);
  }
  console.log(
    "PASS: actual Python Runner/RunState, approvals, os._exit, and resume verified offline.",
  );
} finally {
  for (const child of children) child.kill();
  await Promise.all(
    [...children].map(
      (c) =>
        new Promise((res) => {
          if (c.exitCode !== null || c.signalCode !== null) res();
          else c.once("close", res);
        }),
    ),
  );
  if (server) await server.app.close();
  if (provider) {
    provider.kill();
    await new Promise((res) => {
      if (provider.exitCode !== null || provider.signalCode !== null) res();
      else provider.once("close", res);
    });
  }
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
