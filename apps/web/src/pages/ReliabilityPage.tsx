import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  Copy,
  Download,
  FlaskConical,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { api } from "../api";
import type {
  LabRun,
  LabCaseResult,
  EvidenceEnvelope,
} from "@actionledger/core";
import { Empty } from "../components/ui";
const CASES = [
  { id: "protected-crash", label: "Protected crash" },
  { id: "unprotected-crash", label: "Unprotected crash" },
  { id: "lost-response", label: "Lost TCP response" },
  { id: "provider-error", label: "HTTP 500 after commit" },
  { id: "approval-gate", label: "Durable veto" },
  { id: "payload-conflict", label: "Payload mutation" },
  { id: "concurrent-workers", label: "Concurrent workers" },
  { id: "unsafe-baseline", label: "Naive retry baseline" },
];
function download(report: EvidenceEnvelope, id: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "actionledger-evidence-" + id + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ReliabilityPage() {
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [run, setRun] = useState<LabRun | null>(null);
  const [seed, setSeed] = useState("5409");
  const [selected, setSelected] = useState("protected-crash");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  const mounted = useRef(true);
  const locked = useRef(false);
  const loadHistory = async () => {
    const data = await api<LabRun[]>("/lab/runs");
    if (mounted.current) {
      setRuns(data);
      setRun((current) => current ?? data[0] ?? null);
    }
    return data;
  };
  useEffect(() => {
    mounted.current = true;
    void loadHistory()
      .catch((e) => {
        if (mounted.current) setError(e.message);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (run?.status !== "RUNNING") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await api<LabRun>("/lab/runs/" + run.id, undefined, {
          signal: controller.signal,
        });
        if (stopped) return;
        setRun(next);
        setError(null);
        if (next.status !== "RUNNING") {
          await loadHistory();
          return;
        }
      } catch (e) {
        if (!stopped)
          setError(
            e instanceof Error ? e.message : "Cannot read experiment progress",
          );
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [run?.id, run?.status]);
  const start = async () => {
    if (locked.current) return;
    const value = Number(seed);
    if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
      setError("Use an integer seed from 1 to 2147483647.");
      return;
    }
    locked.current = true;
    setStarting(true);
    setError(null);
    setVerified(null);
    try {
      const next = await api<LabRun>("/lab/runs", { seed: value });
      if (mounted.current) {
        setRun(next);
        setRuns((current) => [next, ...current].slice(0, 20));
      }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : "Cannot start experiments");
        void loadHistory().catch(() => {});
      }
    } finally {
      locked.current = false;
      if (mounted.current) setStarting(false);
    }
  };
  const refresh = async () => {
    try {
      const history = await loadHistory();
      if (mounted.current && run)
        setRun(history.find((r) => r.id === run.id) ?? run);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot refresh runs");
    }
  };
  const verify = async () => {
    if (!run?.report) return;
    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(run.report.evidence)),
      );
      const hex = Array.from(new Uint8Array(digest))
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      setVerified(
        hex === run.report.sha256
          ? "Fingerprint matches in this browser"
          : "Fingerprint mismatch — evidence changed",
      );
    } catch {
      setVerified(
        "Browser verification unavailable; use the offline verifier.",
      );
    }
  };
  const exportReport = async () => {
    if (!run) return;
    try {
      const report = await api<EvidenceEnvelope>(
        "/lab/runs/" + run.id + "/evidence",
      );
      download(report, run.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot export evidence");
    }
  };
  const results = run?.cases ?? [];
  const checks = results.flatMap((c) => c.checks);
  const passed = checks.filter((c) => c.pass).length;
  const scenario: LabCaseResult | undefined = results.find(
    (c) => c.id === selected,
  );
  const active =
    starting ||
    runs.some((r) => r.status === "RUNNING") ||
    run?.status === "RUNNING";
  const naive = results
    .find((c) => c.id === "unsafe-baseline")
    ?.trace.at(-1)?.payments;
  const guarded = results
    .find((c) => c.id === "unprotected-crash")
    ?.trace.at(-1)?.payments;
  return (
    <div className="reliability-page">
      <section className="reliability-hero">
        <div>
          <span className="eyebrow">
            <FlaskConical size={14} />
            RELIABILITY LAB / SUITE 1
          </span>
          <h2>
            Break the process.
            <br />
            <em>Keep the evidence.</em>
          </h2>
          <p>
            Eight real experiments. Independent payment storage. Reproducible
            scenario order. Inspect what survived the failure window.
          </p>
          <div className="lab-command">
            <code>pnpm lab --seed 5409</code>
            <button
              className="icon-button"
              aria-label="Copy laboratory command"
              onClick={() =>
                void navigator.clipboard
                  .writeText("pnpm lab --seed " + seed)
                  .then(() => setVerified("CLI command copied"))
                  .catch(() =>
                    setError(
                      "Clipboard unavailable. Copy the command shown above.",
                    ),
                  )
              }
            >
              <Copy size={14} />
            </button>
          </div>
        </div>
        <div className="lab-launch">
          <span className="eyebrow">LOCAL EXPERIMENT RUNNER</span>
          <label htmlFor="lab-seed">Reproduction seed</label>
          <input
            id="lab-seed"
            type="number"
            min="1"
            max="2147483647"
            step="1"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            disabled={active}
          />
          <button
            className="button primary"
            disabled={active}
            onClick={() => void start()}
          >
            {active ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Play size={16} />
            )}{" "}
            {active ? "Experiments running" : "Run 8 simulated experiments"}
          </button>
          <p>
            Creates synthetic approvals and €10 simulated payments in disposable
            databases. Your action ledger stays untouched.
          </p>
        </div>
      </section>
      {error && (
        <div className="lab-notice danger" role="alert">
          <TriangleAlert size={17} />
          <span>{error} No interrupted run is retried automatically.</span>
          <button className="button small" onClick={() => void refresh()}>
            Refresh runs
          </button>
        </div>
      )}
      <div className="lab-run-toolbar">
        <div>
          <strong>Experiment evidence</strong>
          <span>
            {run
              ? new Date(run.createdAt).toLocaleString()
              : "No experiments run yet"}
          </span>
        </div>
        <div>
          <select
            aria-label="Previous laboratory runs"
            value={run?.id ?? ""}
            onChange={(e) => {
              setRun(runs.find((r) => r.id === e.target.value) ?? null);
              setVerified(null);
            }}
            disabled={!runs.length}
          >
            {!runs.length && <option value="">No saved runs</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                Seed {r.seed} · {r.status} ·{" "}
                {new Date(r.createdAt).toLocaleTimeString()}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            aria-label="Refresh laboratory runs"
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {loading ? (
        <div className="lab-notice">
          <LoaderCircle className="spin" size={17} />
          Loading durable experiments…
        </div>
      ) : (
        <>
          <div className="lab-metrics">
            <div>
              <span>Expected outcomes</span>
              <strong>
                {run ? run.completed : "—"}
                <small> / 8</small>
              </strong>
              <p>{run?.status ?? "Awaiting first run"}</p>
            </div>
            <div>
              <span>Invariant checks</span>
              <strong>
                {checks.length ? passed : "—"}
                <small>{checks.length ? " / " + checks.length : ""}</small>
              </strong>
              <p>
                {checks.some((c) => !c.pass)
                  ? "A check needs investigation"
                  : "Measured, never seeded"}
              </p>
            </div>
            <div>
              <span>Naive replay effects</span>
              <strong className="lab-bad">{naive ?? "—"}</strong>
              <p>Deliberately unsafe counterexample</p>
            </div>
            <div>
              <span>Ledger-guarded effects</span>
              <strong className="lab-good">{guarded ?? "—"}</strong>
              <p>Unprotected uncertainty blocks replay</p>
            </div>
          </div>
          {run && (
            <div
              className={
                "lab-notice " +
                (run.status === "PASSED"
                  ? "success"
                  : run.status === "FAILED"
                    ? "danger"
                    : "")
              }
              role="status"
            >
              {run.status === "RUNNING" ? (
                <LoaderCircle className="spin" size={17} />
              ) : run.status === "PASSED" ? (
                <ShieldCheck size={17} />
              ) : (
                <TriangleAlert size={17} />
              )}
              <span>
                {run.status === "RUNNING"
                  ? "Running isolated processes. Progress is persisted after each experiment."
                  : run.status === "PASSED"
                    ? "All expected outcomes observed — including the intentional duplicate in the unsafe baseline."
                    : (run.error ??
                      "An invariant failed. Inspect the exported evidence.")}
              </span>
            </div>
          )}
          <div className="lab-workbench">
            <aside className="lab-scenarios">
              <div className="lab-section-label">FAILURE MATRIX</div>
              {CASES.map((item, index) => {
                const result = results.find((c) => c.id === item.id);
                const ok = result?.checks.every((c) => c.pass);
                return (
                  <button
                    key={item.id}
                    className={selected === item.id ? "selected" : ""}
                    onClick={() => setSelected(item.id)}
                  >
                    <span
                      className={result ? (ok ? "lab-good" : "lab-bad") : ""}
                    >
                      {result ? (
                        ok ? (
                          <Check size={15} />
                        ) : (
                          <TriangleAlert size={15} />
                        )
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </span>
                    <span>{item.label}</span>
                    <ArrowRight size={13} />
                  </button>
                );
              })}
            </aside>
            <section className="lab-inspector">
              {scenario ? (
                <>
                  <div className="lab-inspector-head">
                    <div>
                      <span className="eyebrow">OBSERVED EXPERIMENT</span>
                      <h3>{scenario.label}</h3>
                    </div>
                    <span className="lab-duration">
                      {scenario.durationMs} ms
                    </span>
                  </div>
                  <div className="lab-payload">
                    <code>{scenario.payload.idempotencyKey}</code>
                    <span>
                      €10.00 → {scenario.payload.recipient} · {scenario.mode}
                    </span>
                  </div>
                  <div className="lab-section-label">
                    STATE & EXTERNAL EFFECTS
                  </div>
                  <div className="lab-traces">
                    {scenario.trace.map((point, index) => (
                      <div className="lab-trace" key={index}>
                        <span className="lab-trace-number">{index + 1}</span>
                        <div>
                          <strong>{point.phase}</strong>
                          <code>
                            {point.status} · {point.attempts} attempts
                          </code>
                        </div>
                        <div>
                          <b>{point.payments}</b>
                          <small>payments</small>
                        </div>
                        <div>
                          <b>{point.requests}</b>
                          <small>requests</small>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="lab-section-label">CHECKED INVARIANTS</div>
                  <div className="lab-checks">
                    {scenario.checks.map((check, index) => (
                      <div key={index}>
                        {check.pass ? (
                          <CheckCheck className="lab-good" size={16} />
                        ) : (
                          <TriangleAlert className="lab-bad" size={16} />
                        )}
                        <span>{check.name}</span>
                        <code>{check.actual}</code>
                      </div>
                    ))}
                  </div>
                  <div className="lab-receipts">
                    <span className="lab-section-label">PROVIDER RECEIPTS</span>
                    {scenario.paymentIds.length ? (
                      scenario.paymentIds.map((id) => (
                        <code key={id}>{id}</code>
                      ))
                    ) : (
                      <p>No external payment recorded.</p>
                    )}
                  </div>
                </>
              ) : (
                <Empty
                  title={
                    run?.status === "RUNNING"
                      ? "Experiment pending"
                      : "Inspect a failure, not a promise"
                  }
                  description={
                    run?.status === "RUNNING"
                      ? "Select a completed experiment or wait for this scenario to finish."
                      : "Run the suite to see real state transitions, payment receipts and checked invariants here."
                  }
                />
              )}
            </section>
          </div>
          <section className="lab-evidence">
            <div>
              <span className="eyebrow">PORTABLE EVIDENCE</span>
              <h3>A report you can take apart.</h3>
              <p>
                JSON includes the seed, runtime, transitions, provider receipt
                IDs and each assertion. SHA-256 detects accidental edits; it is
                not a signature or a formal safety proof.
              </p>
              {run?.report && (
                <code className="lab-fingerprint">{run.report.sha256}</code>
              )}
              {verified && (
                <p className="lab-verification" role="status">
                  {verified}
                </p>
              )}
            </div>
            <div>
              <button
                className="button"
                disabled={!run?.report}
                onClick={() => void exportReport()}
              >
                <Download size={16} />
                Download evidence
              </button>
              <button
                className="button ghost"
                disabled={!run?.report}
                onClick={() => void verify()}
              >
                <ShieldCheck size={16} />
                Verify in this browser
              </button>
            </div>
          </section>
          <p className="lab-footnote">
            A seed reproduces case order and payloads; OS scheduling, UUIDs and
            timings vary. Expected outcomes apply to these observed executions
            and the simulator's indefinite key retention. Local transactions
            alone cannot guarantee exactly-once external effects.
          </p>
        </>
      )}
    </div>
  );
}
