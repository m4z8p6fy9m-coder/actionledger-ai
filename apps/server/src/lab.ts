import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ledger,
  DomainError,
  LabInput,
  LabCase,
  LAB_CASES,
  verifyEvidence,
  type LabRun,
  type LabCaseResult,
  type EvidenceEnvelope,
} from "@actionledger/core";
type Row = {
  id: string;
  seed: number;
  status: LabRun["status"];
  created_at: string;
  finished_at: string | null;
  lease_until: number;
  progress: string;
  report: string | null;
  error: string | null;
};
/** One bounded suite across all API processes sharing the ledger. Results survive restarts. */
export class Laboratory {
  private children = new Map<string, ChildProcess>();
  private closing = false;
  constructor(
    private ledger: Ledger,
    private runnerPath?: string,
    private deadlineMs = 60000,
  ) {
    ledger.db.exec(
      "CREATE TABLE IF NOT EXISTS reliability_runs(id TEXT PRIMARY KEY,seed INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('RUNNING','PASSED','FAILED','INTERRUPTED')),created_at TEXT NOT NULL,finished_at TEXT,lease_until INTEGER NOT NULL,progress TEXT NOT NULL,report TEXT,error TEXT,slot INTEGER NOT NULL DEFAULT 1);CREATE UNIQUE INDEX IF NOT EXISTS one_active_lab ON reliability_runs(slot) WHERE status='RUNNING';",
    );
    this.expire();
  }
  private expire() {
    this.ledger.db
      .prepare(
        "UPDATE reliability_runs SET status='INTERRUPTED',finished_at=?,error='Laboratory lease expired; incomplete experiments are not retried' WHERE status='RUNNING' AND lease_until<=?",
      )
      .run(new Date().toISOString(), Date.now());
  }
  private row(id: string) {
    const row = this.ledger.db
      .prepare("SELECT * FROM reliability_runs WHERE id=?")
      .get(id) as Row | undefined;
    if (!row)
      throw new DomainError("NOT_FOUND", "Laboratory run not found", 404);
    return row;
  }
  private serialize(row: Row): LabRun {
    return {
      id: row.id,
      seed: row.seed,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      completed: JSON.parse(row.progress).length,
      total: LAB_CASES.length,
      cases: JSON.parse(row.progress),
      error: row.error,
      report: row.report ? JSON.parse(row.report) : null,
    };
  }
  list() {
    this.expire();
    return this.ledger.db
      .prepare(
        "SELECT * FROM reliability_runs ORDER BY created_at DESC,id DESC LIMIT 20",
      )
      .all()
      .map((row) => this.serialize(row as Row));
  }
  get(id: string) {
    this.expire();
    return this.serialize(this.row(id));
  }
  export(id: string) {
    const run = this.get(id);
    if (!run.report)
      throw new DomainError(
        "REPORT_INCOMPLETE",
        "Only completed evidence can be exported",
      );
    return verifyEvidence(run.report);
  }
  start(raw: unknown) {
    if (this.closing)
      throw new DomainError("LAB_STOPPING", "Server is shutting down", 503);
    const { seed } = LabInput.parse(raw);
    const id = randomUUID();
    this.ledger.tx(() => {
      this.expire();
      if (
        this.ledger.db
          .prepare("SELECT 1 FROM reliability_runs WHERE status='RUNNING'")
          .get()
      )
        throw new DomainError(
          "LAB_BUSY",
          "Another isolated experiment suite is running",
        );
      this.ledger.db
        .prepare(
          "INSERT INTO reliability_runs(id,seed,status,created_at,lease_until,progress) VALUES(?,?,'RUNNING',?,?,'[]')",
        )
        .run(
          id,
          seed,
          new Date().toISOString(),
          Date.now() + this.deadlineMs + 5000,
        );
    });
    const runner =
      this.runnerPath ??
      fileURLToPath(
        new URL("./lab-runner" + extname(import.meta.url), import.meta.url),
      );
    let child: ChildProcess;
    try {
      child = fork(runner, [String(seed)], {
        execArgv: runner.endsWith(".ts") ? ["--import", "tsx"] : [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    } catch {
      this.finish(id, "FAILED", "Experiment subprocess could not start");
      return this.get(id);
    }
    this.children.set(id, child);
    const timer = setTimeout(() => {
      this.finish(
        id,
        "INTERRUPTED",
        "Experiment deadline exceeded; no automatic retry",
      );
      child.kill();
    }, this.deadlineMs);
    timer.unref();
    child.on("message", (raw: unknown) => {
      try {
        if (JSON.stringify(raw).length > 1048576)
          throw new Error("Oversized laboratory evidence");
        const msg = raw as {
          type?: string;
          result?: unknown;
          report?: unknown;
          error?: string;
        };
        if (msg.type === "case") {
          const result = LabCase.parse(msg.result);
          const row = this.row(id);
          if (row.status !== "RUNNING") return;
          const progress = JSON.parse(row.progress) as LabCaseResult[];
          if (progress.some((c) => c.id === result.id))
            throw new Error("Duplicate scenario result");
          progress.push(result);
          this.ledger.db
            .prepare(
              "UPDATE reliability_runs SET progress=? WHERE id=? AND status='RUNNING'",
            )
            .run(JSON.stringify(progress), id);
        } else if (msg.type === "complete") {
          const report = verifyEvidence(msg.report);
          if (report.evidence.seed !== seed)
            throw new Error("Evidence seed mismatch");
          const progress = JSON.parse(this.row(id).progress) as LabCaseResult[];
          if (
            JSON.stringify(progress) !== JSON.stringify(report.evidence.cases)
          )
            throw new Error("Evidence differs from persisted progress");
          this.finish(
            id,
            report.evidence.cases.every((c) => c.checks.every((k) => k.pass))
              ? "PASSED"
              : "FAILED",
            null,
            report,
          );
        } else if (msg.type === "failed")
          this.finish(
            id,
            "FAILED",
            "Experiment harness failed; inspect server logs",
          );
        else throw new Error("Unexpected laboratory message");
      } catch {
        this.finish(id, "FAILED", "Experiment evidence failed validation");
        child.kill();
      }
    });
    child.once("error", () =>
      this.finish(id, "FAILED", "Experiment subprocess failed to start"),
    );
    child.once("close", () => {
      clearTimeout(timer);
      this.children.delete(id);
      this.finish(
        id,
        this.closing ? "INTERRUPTED" : "FAILED",
        this.closing
          ? "Server stopped during experiment"
          : "Experiment process exited without complete evidence",
      );
    });
    return this.get(id);
  }
  private finish(
    id: string,
    status: LabRun["status"],
    error: string | null,
    report?: EvidenceEnvelope,
  ) {
    this.ledger.db
      .prepare(
        "UPDATE reliability_runs SET status=?,finished_at=?,error=?,report=COALESCE(?,report) WHERE id=? AND status='RUNNING'",
      )
      .run(
        status,
        new Date().toISOString(),
        error,
        report ? JSON.stringify(report) : null,
        id,
      );
  }
  async close() {
    this.closing = true;
    const active = [...this.children];
    for (const [id, child] of active) {
      this.finish(id, "INTERRUPTED", "Server stopped during experiment");
      child.kill();
    }
    await Promise.all(
      active.map(
        ([, child]) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once("close", () => resolve());
          }),
      ),
    );
  }
}
