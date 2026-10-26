import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../apps/server/src/app.js";
import {
  LAB_CASES,
  verifyEvidence,
  evidenceDigest,
  type LabRun,
} from "@actionledger/core";
let dir: string;
let server: Awaited<ReturnType<typeof buildServer>>;
const operator = "lab-operator-test-credential-over-32-chars";
const agent = "lab-agent-test-credential-over-32-characters";
const config = () => ({
  file: join(dir, "ledger.sqlite"),
  apiToken: operator,
  agentToken: agent,
  sessionBootstrap: false,
  providerToken: "unused-main-provider",
  providerUrl: "http://127.0.0.1:1",
});
const request = (
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
  token = operator,
) =>
  server.app.inject({
    method,
    url,
    headers: { authorization: "Bearer " + token },
    ...(payload === undefined ? {} : { payload }),
  });
async function waitRun(id: string) {
  // Keep two consecutive suites below the API's 300 requests/minute limit.
  for (let i = 0; i < 125; i++) {
    const response = await request("GET", "/api/lab/runs/" + id);
    expect(response.statusCode).toBe(200);
    const run = response.json<LabRun>();
    if (run.status !== "RUNNING") return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Laboratory did not finish");
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "actionledger-lab-api-"));
  server = await buildServer(config());
});
afterEach(async () => {
  await server.app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("isolated reliability laboratory", () => {
  it("runs eight real scenarios, persists evidence, and never changes the operator payment ledger", async () => {
    const started = await request("POST", "/api/lab/runs", { seed: 5409 });
    expect(started.statusCode).toBe(202);
    expect(
      (await request("POST", "/api/lab/runs", { seed: 100 })).json().error,
    ).toBe("LAB_BUSY");
    const run = await waitRun(started.json().id);
    expect(run).toMatchObject({
      status: "PASSED",
      completed: 8,
      total: 8,
      error: null,
    });
    expect(run.cases.flatMap((c) => c.checks).every((c) => c.pass)).toBe(true);
    expect(run.cases.map((c) => c.id).sort()).toEqual([...LAB_CASES].sort());
    const protectedCrash = run.cases.find((c) => c.id === "protected-crash")!;
    const unprotected = run.cases.find((c) => c.id === "unprotected-crash")!;
    const baseline = run.cases.find((c) => c.id === "unsafe-baseline")!;
    expect(protectedCrash.trace.at(-1)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 2,
      payments: 1,
      requests: 2,
    });
    expect(unprotected.trace.at(-1)).toMatchObject({
      status: "UNKNOWN",
      attempts: 1,
      payments: 1,
      requests: 1,
    });
    expect(baseline.paymentIds).toHaveLength(2);
    expect(baseline.approval).toBeNull();
    expect(server.ledger.snapshot().actions).toHaveLength(0);
    expect(server.ledger.snapshot().audit).toHaveLength(0);
    const downloaded = await request(
      "GET",
      "/api/lab/runs/" + run.id + "/evidence",
    );
    expect(downloaded.headers["content-disposition"]).toContain("attachment");
    expect(verifyEvidence(downloaded.json()).sha256).toBe(run.report!.sha256);
    await server.app.close();
    server = await buildServer(config());
    expect((await request("GET", "/api/lab/runs/" + run.id)).json()).toEqual(
      run,
    );
    expect((await request("GET", "/api/lab/runs")).json()[0].id).toBe(run.id);
  });
  it("reproduces seeded order and payloads across two independent process suites", async () => {
    const firstStart = await request("POST", "/api/lab/runs", { seed: 42 });
    const a = await waitRun(firstStart.json().id);
    const secondStart = await request("POST", "/api/lab/runs", { seed: 42 });
    const b = await waitRun(secondStart.json().id);
    expect(a.status).toBe("PASSED");
    expect(b.status).toBe("PASSED");
    expect(a.cases.map((c) => ({ id: c.id, payload: c.payload }))).toEqual(
      b.cases.map((c) => ({ id: c.id, payload: c.payload })),
    );
    expect(
      a.cases.find((c) => c.id === "protected-crash")!.paymentIds,
    ).not.toEqual(b.cases.find((c) => c.id === "protected-crash")!.paymentIds);
    expect(a.report!.sha256).not.toBe(b.report!.sha256);
  });
  it("rejects missing auth, agent credentials, invalid seeds and unknown fields", async () => {
    expect(
      (await server.app.inject({ method: "GET", url: "/api/lab/runs" }))
        .statusCode,
    ).toBe(401);
    expect(
      (await request("POST", "/api/lab/runs", { seed: 1 }, agent)).statusCode,
    ).toBe(403);
    for (const seed of [0, -1, 2147483648, 1.5, "42"])
      expect(
        (await request("POST", "/api/lab/runs", { seed })).statusCode,
      ).toBe(400);
    expect(
      (
        await request("POST", "/api/lab/runs", {
          seed: 1,
          providerUrl: "https://evil.example",
        })
      ).statusCode,
    ).toBe(400);
    expect((await request("GET", "/api/lab/runs/invalid")).statusCode).toBe(
      400,
    );
  });
  it("bounds work, refuses partial exports, and persists deadline interruption", async () => {
    await server.app.close();
    const fixture = join(dir, "stalled.mjs");
    writeFileSync(fixture, "setInterval(()=>{},1000);");
    server = await buildServer({
      ...config(),
      labRunnerPath: fixture,
      labDeadlineMs: 250,
    });
    const id = (await request("POST", "/api/lab/runs", { seed: 7 })).json().id;
    expect(
      (await request("GET", "/api/lab/runs/" + id + "/evidence")).json().error,
    ).toBe("REPORT_INCOMPLETE");
    const run = await waitRun(id);
    expect(run.status).toBe("INTERRUPTED");
    expect(run.report).toBeNull();
    await server.app.close();
    server = await buildServer(config());
    expect((await request("GET", "/api/lab/runs/" + id)).json().status).toBe(
      "INTERRUPTED",
    );
  });
  it("marks an in-flight suite interrupted on orderly API shutdown without rerunning it", async () => {
    await server.app.close();
    const fixture = join(dir, "stopped.mjs");
    writeFileSync(fixture, "setInterval(()=>{},1000);");
    server = await buildServer({ ...config(), labRunnerPath: fixture });
    const id = (await request("POST", "/api/lab/runs", { seed: 8 })).json().id;
    await server.app.close();
    server = await buildServer(config());
    const history = (await request("GET", "/api/lab/runs")).json();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id,
      status: "INTERRUPTED",
      completed: 0,
    });
  });
  it("expires abandoned leases conservatively and enforces one active suite across API instances", async () => {
    await server.app.close();
    const fixture = join(dir, "exclusive.mjs");
    writeFileSync(fixture, "setInterval(()=>{},1000);");
    server = await buildServer({ ...config(), labRunnerPath: fixture });
    const id = (await request("POST", "/api/lab/runs", { seed: 9 })).json().id;
    const second = await buildServer(config());
    try {
      const response = await second.app.inject({
        method: "POST",
        url: "/api/lab/runs",
        headers: { authorization: "Bearer " + operator },
        payload: { seed: 10 },
      });
      expect(response.json().error).toBe("LAB_BUSY");
      server.ledger.db
        .prepare("UPDATE reliability_runs SET lease_until=0 WHERE id=?")
        .run(id);
      expect((await request("GET", "/api/lab/runs/" + id)).json().status).toBe(
        "INTERRUPTED",
      );
    } finally {
      await second.app.close();
    }
  });
  it("rejects malformed subprocess evidence instead of displaying invented success", async () => {
    await server.app.close();
    const fixture = join(dir, "invalid.mjs");
    writeFileSync(
      fixture,
      'process.send({type:"complete",report:{evidence:{},sha256:"fake"}});',
    );
    server = await buildServer({ ...config(), labRunnerPath: fixture });
    const id = (await request("POST", "/api/lab/runs", { seed: 1 })).json().id;
    const run = await waitRun(id);
    expect(run.status).toBe("FAILED");
    expect(run.report).toBeNull();
  });
  it("detects edited JSON, duplicate scenarios, and inconsistent assertion flags", async () => {
    const id = (await request("POST", "/api/lab/runs", { seed: 5409 })).json()
      .id;
    const run = await waitRun(id);
    const exportedFile = join(dir, "evidence.json");
    writeFileSync(exportedFile, JSON.stringify(run.report));
    const verifier = fileURLToPath(
      new URL("../scripts/verify-evidence.mjs", import.meta.url),
    );
    const validCli = spawnSync(process.execPath, [verifier, exportedFile], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(validCli.status, validCli.stderr).toBe(0);
    expect(validCli.stdout).toContain("36/36 checks passed");
    const edited = structuredClone(run.report!);
    edited.evidence.seed = 123;
    writeFileSync(exportedFile, JSON.stringify(edited));
    const editedCli = spawnSync(process.execPath, [verifier, exportedFile], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(editedCli.status).not.toBe(0);
    expect(editedCli.stderr).toContain("fingerprint mismatch");
    expect(() => verifyEvidence(edited)).toThrow("fingerprint");
    const duplicate = structuredClone(run.report!);
    duplicate.evidence.cases[1] = duplicate.evidence.cases[0];
    duplicate.sha256 = evidenceDigest(duplicate.evidence);
    expect(() => verifyEvidence(duplicate)).toThrow("every scenario");
    const inconsistent = structuredClone(run.report!);
    inconsistent.evidence.cases[0].checks[0].pass = false;
    inconsistent.sha256 = evidenceDigest(inconsistent.evidence);
    expect(() => verifyEvidence(inconsistent)).toThrow("Inconsistent");
  });
});
