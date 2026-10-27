import { version as appVersion } from "../package.json";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronRight,
  Command,
  Database,
  ExternalLink,
  FileClock,
  FlaskConical,
  GitBranch,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import {
  api,
  ApiError,
  money,
  payload,
  time,
  type Action,
  type Audit,
  type Detail,
  type Status,
} from "./api";
import { Badge, Empty, Modal, Metric, LabStep } from "./components/ui";
import { CreateModal, ApprovalModal } from "./components/ActionForms";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useLedgerSnapshot } from "./hooks/useLedgerSnapshot";
import { ActionsPage } from "./pages/ActionsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { ActionsTable } from "./components/ActionsTable";
import { ReliabilityPage } from "./pages/ReliabilityPage";
import "./style.css";
type Page =
  | "Overview"
  | "Actions"
  | "Approvals"
  | "Reliability lab"
  | "Crash lab"
  | "Audit trail"
  | "Architecture";
const pages: { label: Page; icon: typeof Activity }[] = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Actions", icon: Workflow },
  { label: "Approvals", icon: ShieldCheck },
  { label: "Crash lab", icon: FlaskConical },
  { label: "Reliability lab", icon: ShieldCheck },
  { label: "Audit trail", icon: FileClock },
];
function App() {
  const [page, setPage] = useState<Page>("Overview");
  const {
    data,
    connection,
    error: connectionError,
    lastUpdated,
    refreshing,
    refresh,
  } = useLedgerSnapshot();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [create, setCreate] = useState(false);
  const [approval, setApproval] = useState<{
    action: Action;
    decision: "approve" | "reject";
  } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [mode, setMode] = useState<"idempotent" | "unprotected">("idempotent");
  const [demoIds, setDemoIds] = useState<Record<string, string>>(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem("actionledger.demo") ?? "{}",
      );
      if (!stored || typeof stored !== "object" || Array.isArray(stored))
        return {};
      return Object.fromEntries(
        Object.entries(stored).filter(
          ([key, value]) =>
            ["idempotent", "unprotected"].includes(key) &&
            typeof value === "string" &&
            /^[0-9a-f-]{36}$/i.test(value),
        ),
      );
    } catch {
      return {};
    }
  });
  const [demoFallback, setDemoFallback] = useState<Action | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(id);
  }, [toast]);
  const work = async <T,>(
    fn: () => Promise<T>,
    message?: string,
  ): Promise<T | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await fn();
      if (message) setToast({ text: message, error: false });
      await refresh();
      return result;
    } catch (e) {
      setToast({
        text:
          e instanceof ApiError && e.requestId
            ? e.message + " · Reference: " + e.requestId
            : e instanceof Error
              ? e.message
              : "Operation failed",
        error: true,
      });
      await refresh();
      return undefined;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const openDetail = async (id: string) => {
    await work(async () => {
      setDetail(await api<Detail>("/actions/" + id));
    });
  };
  const count = (status: Status) =>
    Number(data?.counts.find((c) => c.status === status)?.count ?? 0);
  const total = data?.counts.reduce((s, c) => s + Number(c.count), 0) ?? 0;
  const navigate = (next: Page) => {
    setPage(next);
    setQuery("");
    setFilter("ALL");
  };
  const demo =
    data?.actions.find((a) => a.id === demoIds[mode]) ??
    (demoFallback?.id === demoIds[mode] ? demoFallback : null);
  useEffect(() => {
    const id = demoIds[mode];
    if (id)
      void api<Detail>("/actions/" + id)
        .then((d) => setDemoFallback(d.action))
        .catch(() => setDemoFallback(null));
  }, [mode, demoIds, data]);
  const createDemo = () =>
    work(async () => {
      const result = await api<{ action: Action }>("/actions", {
        idempotencyKey: "demo." + crypto.randomUUID(),
        recipient: "Alice",
        amountCents: 1000,
        currency: "EUR",
        providerMode: mode,
        description: "Crash lab · payment checkpoint test",
      });
      const ids = { ...demoIds, [mode]: result.action.id };
      setDemoIds(ids);
      try {
        localStorage.setItem("actionledger.demo", JSON.stringify(ids));
      } catch {
        /* Browser preferences must never invalidate a durable intent. */
      }
      return result;
    }, "€10 scenario created. Human approval is required.");
  const execute = (action: Action, crash = false) =>
    work(
      async () => {
        const result = await api<{ action: Action; crashed: boolean }>(
          "/actions/" + action.id + "/execute",
          { simulateCrash: crash },
        );
        if (detail?.action.id === action.id)
          setDetail(await api<Detail>("/actions/" + action.id));
        return result;
      },
      crash
        ? "Worker exited after provider commit. Ledger outcome is UNKNOWN."
        : "Payment execution completed.",
    );
  const recover = (action: Action) =>
    work(async () => {
      const result = await api("/actions/" + action.id + "/recover", {});
      if (detail?.action.id === action.id)
        setDetail(await api<Detail>("/actions/" + action.id));
      return result;
    }, "Recovery completed using the original provider key.");
  const table = (compact = false) => (
    <ActionsTable
      items={(data?.actions ?? []).slice(0, compact ? 6 : 200)}
      busy={busy}
      onInspect={(id) => void openDetail(id)}
      onCreate={() => setCreate(true)}
    />
  );
  const activity = (events: Audit[]) =>
    events.length ? (
      <div className="activity-list">
        {events.map((event) => (
          <button
            key={event.seq}
            className="activity-row"
            onClick={() => event.action_id && void openDetail(event.action_id)}
          >
            <span
              className={
                "event-dot " +
                (event.event.includes("UNKNOWN") ? "warning" : "")
              }
            />
            <span>
              <strong>{event.event.toLowerCase().replaceAll("_", " ")}</strong>
              <code>{event.action_id?.slice(0, 18) ?? "system"}</code>
            </span>
            <time>{time(event.created_at)}</time>
            <ChevronRight size={13} />
          </button>
        ))}
      </div>
    ) : (
      <div className="quiet-empty">
        No events yet. Every transition will leave a trail.
      </div>
    );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          aria-label="ActionLedger AI home"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("Overview");
          }}
        >
          <span className="brand-mark">
            <img
              src="/brand/actionledger-icon.png"
              width="36"
              height="36"
              alt=""
            />
          </span>
          <span>
            ActionLedger<span className="ai-tag">AI</span>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">
            <Command size={16} />
          </span>
          <div>
            <strong>Local workspace</strong>
            <span>Personal environment</span>
          </div>
          <LockKeyhole size={13} />
        </div>
        <div className="nav-caption">CONTROL PLANE</div>
        <nav>
          {pages.map(({ label, icon: Icon }) => (
            <button
              key={label}
              aria-label={label}
              className={page === label ? "active" : ""}
              onClick={() => navigate(label)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {label === "Approvals" && count("PENDING_APPROVAL") > 0 ? (
                <span className="nav-count">{count("PENDING_APPROVAL")}</span>
              ) : label === "Crash lab" ? (
                <span className="lab-dot" />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="nav-caption resources">RESOURCES</div>
        <nav>
          <button
            aria-label="Architecture"
            className={page === "Architecture" ? "active" : ""}
            onClick={() => navigate("Architecture")}
          >
            <BookOpen size={18} />
            <span>Architecture</span>
            <ArrowUpRight size={13} />
          </button>
          <a
            href="https://github.com/openai/openai-agents-python/issues/5409"
            target="_blank"
            rel="noreferrer"
          >
            <GitBranch size={18} />
            <span>Inspiration · #5409</span>
            <ExternalLink size={12} />
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="environment">
            <span className="status-light" />
            <div>
              <strong>Runs on your machine</strong>
              <span>SQLite · No API key required</span>
            </div>
          </div>
          <div className="version">
            <span>v{appVersion} · Open source</span>
            <Shield size={13} />
          </div>
          <p>
            An independent project.
            <br />
            Not affiliated with OpenAI.
          </p>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Control plane <span>/</span>
            <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            {lastUpdated && (
              <span className="updated-at">
                Updated {time(new Date(lastUpdated).toISOString())}
              </span>
            )}
            <span className="local-label">
              <Terminal size={13} />
              localhost
            </span>
            <span
              className={
                "connection " +
                (connection === "Connected" ? "online" : "offline")
              }
            >
              <span />
              {connection}
            </span>
            <button
              className="icon-button"
              aria-label="Refresh data"
              disabled={busy || refreshing}
              onClick={() => void work(refresh, "Ledger refreshed")}
            >
              <RefreshCw
                size={15}
                className={busy || refreshing ? "spin" : ""}
              />
            </button>
          </div>
        </header>
        <main id="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span />
                LOCAL AGENT INFRASTRUCTURE
              </div>
              <h1>
                {page === "Overview"
                  ? "Agent operations"
                  : page === "Reliability lab"
                    ? "Reliability lab"
                    : page === "Crash lab"
                      ? "Crash recovery lab"
                      : page === "Audit trail"
                        ? "An unbroken trail"
                        : page === "Architecture"
                          ? "Built around the failure window"
                          : page}
              </h1>
              <p>
                {page === "Overview"
                  ? "A durable record between intent and impact."
                  : page === "Reliability lab"
                    ? "Run failure experiments. Inspect measured outcomes. Export the evidence."
                    : page === "Crash lab"
                      ? "Break the worker. Keep the evidence. Recover with confidence."
                      : page === "Actions"
                        ? "Inspect every intent, decision, attempt, and external outcome."
                        : page === "Approvals"
                          ? "Human judgment, durably recorded before execution."
                          : page === "Audit trail"
                            ? "Every decision and state transition, in sequence."
                            : "Local transactions protect the ledger. Provider guarantees protect external effects."}
              </p>
            </div>
            <div className="heading-actions">
              {page === "Overview" && (
                <button
                  className="button secondary"
                  onClick={() => {
                    navigate("Actions");
                    setFilter("UNKNOWN");
                  }}
                >
                  <RefreshCw size={15} />
                  Recovery queue{" "}
                  {count("UNKNOWN") > 0 && <span>{count("UNKNOWN")}</span>}
                </button>
              )}
              <button
                className="button primary"
                onClick={() => setCreate(true)}
                disabled={busy}
              >
                <Plus size={16} />
                New action
              </button>
            </div>
          </div>
          {connectionError && (
            <div className="alert danger connection-alert" role="alert">
              <TriangleAlert size={18} />
              <div>
                <strong>Connection interrupted</strong>
                <p>
                  {connectionError}{" "}
                  {lastUpdated
                    ? "The last successful snapshot is still visible."
                    : "Start the local services with pnpm dev."}
                </p>
              </div>
              <button
                className="button secondary small-button"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
                Reconnect
              </button>
            </div>
          )}
          {!data ? (
            connectionError ? (
              <section className="panel">
                <Empty
                  title="Your ledger is safe on disk"
                  description="The dashboard cannot reach the local service. Reconnect after starting the app; no execution requests are replayed automatically."
                />
              </section>
            ) : (
              <div className="loading" role="status">
                <LoaderCircle className="spin" />
                Connecting to your local ledger…
              </div>
            )
          ) : (
            <>
              {(page === "Overview" || page === "Actions") && (
                <div className="stats-grid">
                  <Metric
                    label="Total actions"
                    value={String(total)}
                    icon={Workflow}
                    footer={data.duplicates + " duplicate submissions blocked"}
                  />
                  <Metric
                    label="Awaiting approval"
                    value={String(count("PENDING_APPROVAL"))}
                    icon={ShieldCheck}
                    accent="amber"
                    footer="Every payment needs a human decision"
                  />
                  <Metric
                    label="External payments"
                    value={String(data.provider?.paymentCount ?? "—")}
                    icon={ArrowUpRight}
                    footer={
                      data.provider
                        ? money(data.provider.totalCents) +
                          " committed by the provider"
                        : "Provider is unavailable"
                    }
                  />
                  <Metric
                    label="Safe provider replays"
                    value={String(data.provider?.deduplicated ?? "—")}
                    icon={CheckCheck}
                    accent="green"
                    footer="Repeated requests · no extra payment"
                  />
                </div>
              )}
              {page === "Overview" && (
                <>
                  <section className="lab-banner">
                    <div className="banner-grid" />
                    <div className="banner-content">
                      <span className="pill">
                        <FlaskConical size={13} />
                        INTERACTIVE FAILURE TEST
                      </span>
                      <h2>One payment. Even after a crash.</h2>
                      <p>
                        Send €10, terminate the worker before its checkpoint,
                        <br className="desktop-break" /> then see what safe
                        recovery actually means.
                      </p>
                      <button
                        className="button light"
                        onClick={() => navigate("Crash lab")}
                      >
                        Open crash lab
                        <ArrowRight size={15} />
                      </button>
                    </div>
                    <div className="pipeline">
                      <div className="pipeline-step">
                        <span>
                          <ShieldCheck size={19} />
                        </span>
                        <strong>Approve</strong>
                        <small>Durable decision</small>
                      </div>
                      <div className="pipeline-line" />
                      <div className="pipeline-step crash">
                        <span>
                          <Zap size={19} />
                        </span>
                        <strong>Crash</strong>
                        <small>After provider commit</small>
                      </div>
                      <div className="pipeline-line" />
                      <div className="pipeline-step">
                        <span>
                          <RefreshCw size={19} />
                        </span>
                        <strong>Recover</strong>
                        <small>Same provider key</small>
                      </div>
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          Recent actions{" "}
                          <span className="count-label">{total}</span>
                        </h2>
                        <p>Live records from your persistent ledger</p>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => navigate("Actions")}
                      >
                        View all actions
                        <ArrowRight size={14} />
                      </button>
                    </div>
                    {table(true)}
                  </section>
                  <div className="bottom-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Latest activity</h2>
                        <button
                          className="text-button"
                          onClick={() => navigate("Audit trail")}
                        >
                          Audit trail
                          <ArrowUpRight size={14} />
                        </button>
                      </div>
                      {activity(data.audit.slice(0, 5))}
                    </section>
                    <section className="panel safety-panel">
                      <div className="panel-heading">
                        <h2>Safety posture</h2>
                        <ShieldCheck size={18} className="lime" />
                      </div>
                      <div className="safety-row">
                        <span>Human approval</span>
                        <span className="policy protected">
                          <Check size={13} />
                          Enforced
                        </span>
                      </div>
                      <div className="safety-row">
                        <span>Uncertain unprotected actions</span>
                        <span className="policy protected">
                          <LockKeyhole size={12} />
                          Replay blocked
                        </span>
                      </div>
                      <div className="safety-row">
                        <span>Worker coordination</span>
                        <code>SQLite lease + fencing</code>
                      </div>
                      <div className="safety-row">
                        <span>Persistence</span>
                        <code>2 independent databases</code>
                      </div>
                      <p className="safety-note">
                        <Shield size={14} />
                        External execution guarantees depend on the provider.
                      </p>
                    </section>
                  </div>
                </>
              )}
              {page === "Actions" && (
                <ActionsPage
                  initialStatus={filter}
                  revision={lastUpdated}
                  counts={data.counts}
                  busy={busy}
                  onInspect={(id) => void openDetail(id)}
                  onCreate={() => setCreate(true)}
                  onNotice={(text, error = false) => setToast({ text, error })}
                />
              )}
              {page === "Approvals" && (
                <ApprovalsPage
                  revision={lastUpdated}
                  busy={busy}
                  onReview={(action, decision) =>
                    setApproval({ action, decision })
                  }
                />
              )}
              {page === "Reliability lab" && <ReliabilityPage />}
              {page === "Crash lab" && (
                <>
                  <div className="mode-tabs">
                    <button
                      className={mode === "idempotent" ? "selected" : ""}
                      onClick={() => setMode("idempotent")}
                    >
                      <ShieldCheck size={16} />
                      Provider idempotency <span>Protected</span>
                    </button>
                    <button
                      className={mode === "unprotected" ? "selected" : ""}
                      onClick={() => setMode("unprotected")}
                    >
                      <ShieldAlert size={16} />
                      No provider idempotency <span>Conservative</span>
                    </button>
                  </div>
                  <div className="lab-layout">
                    <section className="panel experiment">
                      <div className="panel-heading">
                        <div>
                          <span className="eyebrow">
                            EXPERIMENT / {mode === "idempotent" ? "01" : "02"}
                          </span>
                          <h2>The €10 checkpoint gap</h2>
                        </div>
                        <span className="pill">REAL PROCESS EXIT</span>
                      </div>
                      <div className="experiment-intro">
                        {mode === "idempotent"
                          ? "The provider remembers the original key. A recovery request returns the existing receipt without charging again."
                          : "The provider cannot deduplicate. After a crash, the ledger preserves uncertainty and refuses to issue a second payment."}
                      </div>
                      <div className="lab-steps">
                        <LabStep
                          number="01"
                          title="Record the intent"
                          description="Persist a €10 payment to Alice with a unique logical key."
                          done={!!demo}
                        >
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => void createDemo()}
                          >
                            {demo
                              ? "Create another scenario"
                              : "Create scenario"}
                            <Plus size={14} />
                          </button>
                        </LabStep>
                        <LabStep
                          number="02"
                          title="Get human approval"
                          description="A person reviews the exact amount, recipient, and provider policy."
                          done={
                            !!demo &&
                            demo.status !== "PENDING_APPROVAL" &&
                            demo.status !== "REJECTED"
                          }
                        >
                          <button
                            className="button secondary"
                            disabled={
                              busy ||
                              !demo ||
                              demo.status !== "PENDING_APPROVAL"
                            }
                            onClick={() =>
                              demo &&
                              setApproval({ action: demo, decision: "approve" })
                            }
                          >
                            Review & approve
                            <ShieldCheck size={14} />
                          </button>
                        </LabStep>
                        <LabStep
                          number="03"
                          title="Pay, then crash"
                          description="Provider commits €10. The worker exits before saving its receipt."
                          done={!!demo && demo.attempts > 0}
                        >
                          <button
                            className="button crash-button"
                            disabled={busy || !demo || demo.status !== "READY"}
                            onClick={() => demo && void execute(demo, true)}
                          >
                            Execute & crash
                            <Zap size={14} />
                          </button>
                        </LabStep>
                        <LabStep
                          number="04"
                          title={
                            mode === "idempotent"
                              ? "Recover safely"
                              : "Preserve the unknown"
                          }
                          description={
                            mode === "idempotent"
                              ? "Reuse the original key and checkpoint the existing receipt."
                              : "Recovery must refuse replay. No finality proof means no safe retry."
                          }
                          done={
                            !!demo &&
                            (demo.status === "SUCCEEDED" ||
                              (demo.status === "UNKNOWN" &&
                                mode === "unprotected"))
                          }
                        >
                          <button
                            className="button primary"
                            disabled={
                              busy ||
                              !demo ||
                              !["UNKNOWN", "RUNNING"].includes(demo.status)
                            }
                            onClick={() => demo && void recover(demo)}
                          >
                            {mode === "idempotent"
                              ? "Recover action"
                              : "Check recovery policy"}
                            <RefreshCw size={14} />
                          </button>
                        </LabStep>
                      </div>
                    </section>
                    <div className="lab-evidence">
                      <section className="panel">
                        <div className="panel-heading">
                          <h2>Live evidence</h2>
                          <span className="live-dot" />
                        </div>
                        <div className="evidence-body">
                          <div className="evidence-status">
                            <span>Ledger state</span>
                            {demo ? (
                              <Badge status={demo.status} />
                            ) : (
                              <code>NOT CREATED</code>
                            )}
                          </div>
                          <div className="evidence-number">
                            <span>Recent provider receipts for this key</span>
                            <strong>
                              {demo && data.provider
                                ? data.provider.payments.filter(
                                    (p) =>
                                      p.logicalKey === demo.idempotency_key,
                                  ).length
                                : data.provider
                                  ? 0
                                  : "—"}
                              <small>× €10</small>
                            </strong>
                          </div>
                          <div className="safety-row">
                            <span>Execution attempts</span>
                            <code>{demo?.attempts ?? 0}</code>
                          </div>
                          <div className="safety-row">
                            <span>Durable receipt</span>
                            <code>{demo?.receipt ? "RECORDED" : "NONE"}</code>
                          </div>
                          {demo && (
                            <>
                              <code className="key-block">
                                {demo.idempotency_key}
                              </code>
                              <button
                                className="text-button"
                                onClick={() => void openDetail(demo.id)}
                              >
                                Inspect action & attempts
                                <ArrowUpRight size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </section>
                      <div className="guarantee-note">
                        <TriangleAlert size={18} />
                        <h3>The boundary matters.</h3>
                        <p>
                          A local database transaction cannot guarantee
                          exactly-once execution in an external system. Safe
                          replay relies on the provider enforcing a stable key.
                        </p>
                        <p>
                          A missing provider result is never treated as proof
                          that a payment did not happen.
                        </p>
                      </div>
                    </div>
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Provider receipts</h2>
                      <span className="muted small">
                        Independent provider.sqlite
                      </span>
                    </div>
                    {data.provider?.payments
                      .filter(
                        (p) => demo && p.logicalKey === demo.idempotency_key,
                      )
                      .map((p) => (
                        <div className="receipt-row" key={p.id}>
                          <CheckCheck size={18} className="lime" />
                          <div>
                            <strong>
                              {money(p.amountCents)} paid to {p.recipient}
                            </strong>
                            <code>{p.id}</code>
                          </div>
                          <span className="muted mono small">
                            {time(p.createdAt)}
                          </span>
                        </div>
                      ))}
                    {!data.provider?.payments.some(
                      (p) => demo && p.logicalKey === demo.idempotency_key,
                    ) && (
                      <div className="quiet-empty">
                        No provider receipt for this scenario yet.
                      </div>
                    )}
                  </section>
                </>
              )}
              {page === "Audit trail" && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Persistent event log</h2>
                      <p>
                        Latest 200 events · Full history available through the
                        cursor API
                      </p>
                    </div>
                    <span className="pill">
                      <Database size={13} />
                      SQLITE WAL
                    </span>
                  </div>
                  <div className="table-tools">
                    <div className="search">
                      <Search size={16} />
                      <input
                        aria-label="Search audit events"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter events, action IDs, or details…"
                      />
                    </div>
                  </div>
                  <div className="audit-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Sequence</th>
                          <th>Event</th>
                          <th>Action</th>
                          <th>Details</th>
                          <th>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.audit
                          .filter((e) =>
                            (e.event + e.action_id + e.detail)
                              .toLowerCase()
                              .includes(query.toLowerCase()),
                          )
                          .map((e) => (
                            <tr
                              key={e.seq}
                              onClick={() =>
                                e.action_id && void openDetail(e.action_id)
                              }
                            >
                              <td className="mono muted">
                                #{String(e.seq).padStart(4, "0")}
                              </td>
                              <td>
                                <span
                                  className={
                                    "audit-event " +
                                    (e.event.includes("UNKNOWN") ? "amber" : "")
                                  }
                                >
                                  {e.event}
                                </span>
                              </td>
                              <td>
                                <code>
                                  {e.action_id?.slice(0, 12) ?? "system"}
                                </code>
                              </td>
                              <td className="audit-detail">
                                <code>{e.detail}</code>
                              </td>
                              <td className="mono muted small">
                                {time(e.created_at)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                    {data.audit.length === 0 && (
                      <Empty
                        title="No events yet"
                        description="Create an action to start the persistent audit trail."
                      />
                    )}
                  </div>
                </section>
              )}
              {page === "Architecture" && (
                <>
                  <section className="panel architecture">
                    <h2>Intent → approval → effect → evidence</h2>
                    <p>
                      The ledger and payment provider are independent failure
                      domains. The worker bridges them; it cannot commit them
                      atomically.
                    </p>
                    <div className="architecture-flow">
                      <div>
                        <LayoutDashboard />
                        <strong>React dashboard</strong>
                        <small>Local session + explicit decisions</small>
                      </div>
                      <ArrowRight />
                      <div>
                        <Database />
                        <strong>Fastify + ledger.sqlite</strong>
                        <small>Intent, approval, lease, audit</small>
                      </div>
                      <ArrowRight />
                      <div>
                        <Terminal />
                        <strong>Isolated worker</strong>
                        <small>Claim → dispatch → checkpoint</small>
                      </div>
                      <ArrowRight />
                      <div>
                        <Database />
                        <strong>Payment provider</strong>
                        <small>HTTP + provider.sqlite</small>
                      </div>
                    </div>
                  </section>
                  <div className="bottom-grid">
                    <section className="panel docs">
                      <h2>Recovery contract</h2>
                      <p>
                        <strong>With provider idempotency:</strong> retry the
                        exact logical action using the original immutable key.
                        The provider returns its saved receipt. The ledger
                        records success.
                      </p>
                      <p>
                        <strong>Without provider idempotency:</strong> an
                        interrupted or timed out operation remains UNKNOWN.
                        Neither a timeout nor an empty lookup proves that an
                        earlier attempt cannot still settle.
                      </p>
                      <p>
                        ActionLedger never automatically replays an uncertain
                        unprotected payment. There is intentionally no button to
                        override this boundary.
                      </p>
                    </section>
                    <section className="panel docs">
                      <h2>Local security model</h2>
                      <p>
                        Services bind to loopback. Separate random credentials
                        protect ledger and provider routes. The API checks Host
                        and Origin, validates strict request schemas, and limits
                        request rates.
                      </p>
                      <p>
                        The browser obtains a local session token over the same
                        origin. This is a single-user development control plane:
                        processes and users with access to your machine or data
                        files are trusted.
                      </p>
                      <p>
                        See README.md, docs/ARCHITECTURE.md, and SECURITY.md in
                        the project for the full contract.
                      </p>
                    </section>
                  </div>
                  <div className="info-strip">
                    <BookOpen size={18} />
                    <span>
                      Independent open-source project. Inspired by Agents SDK
                      issue #5409; not affiliated with or endorsed by OpenAI.
                    </span>
                  </div>
                </>
              )}
            </>
          )}
          <footer>
            <span>
              <ShieldCheck size={13} />
              Durable intent. Conservative recovery.
            </span>
            <span>
              100% local <span className="footer-dot">·</span> No paid APIs{" "}
              <span className="footer-dot">·</span> MIT licensed
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className={"toast " + (toast.error ? "error" : "")} role="status">
          {toast.error ? <TriangleAlert size={18} /> : <Check size={18} />}
          <span>{toast.text}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {create && (
        <CreateModal
          busy={busy}
          onClose={() => setCreate(false)}
          onSubmit={(body) =>
            void work(async () => {
              const result = await api<{ action: Action; duplicate: boolean }>(
                "/actions",
                body,
              );
              setCreate(false);
              navigate("Actions");
              setToast({
                text: result.duplicate
                  ? "Duplicate detected. Existing action returned."
                  : "Payment intent recorded. Awaiting human approval.",
                error: false,
              });
            })
          }
        />
      )}
      {approval && (
        <ApprovalModal
          action={approval.action}
          decision={approval.decision}
          busy={busy}
          onClose={() => setApproval(null)}
          onSubmit={(actor, reason) =>
            void work(
              async () => {
                await api("/actions/" + approval.action.id + "/approval", {
                  decision: approval.decision,
                  actor,
                  reason,
                });
                if (detail?.action.id === approval.action.id)
                  setDetail(
                    await api<Detail>("/actions/" + approval.action.id),
                  );
                setApproval(null);
              },
              approval.decision === "approve"
                ? "Approval persisted. Payment is ready for execution."
                : "Rejection persisted. Execution is blocked.",
            )
          }
        />
      )}
      {detail && (
        <Modal title="Action inspector" onClose={() => setDetail(null)}>
          <div className="detail-body">
            <div className="detail-title">
              <h2>
                {money(payload(detail.action).amountCents)} to{" "}
                {payload(detail.action).recipient}
              </h2>
              <Badge status={detail.action.status} />
            </div>
            <dl>
              <dt>Action ID</dt>
              <dd>{detail.action.id}</dd>
              <dt>Idempotency key</dt>
              <dd>{detail.action.idempotency_key}</dd>
              <dt>Provider policy</dt>
              <dd>{payload(detail.action).providerMode}</dd>
              <dt>Description</dt>
              <dd>{payload(detail.action).description}</dd>
              <dt>Approval</dt>
              <dd>
                {detail.approval
                  ? detail.approval.decision +
                    " · " +
                    detail.approval.actor +
                    " · " +
                    detail.approval.reason
                  : "Awaiting explicit decision"}
              </dd>
              <dt>Created</dt>
              <dd>{new Date(detail.action.created_at).toLocaleString()}</dd>
            </dl>
            {detail.action.error && (
              <div className="alert">
                <TriangleAlert size={16} />
                {detail.action.error}
              </div>
            )}
            <h3>Execution attempts</h3>
            {detail.attempts.length ? (
              detail.attempts.map((a) => (
                <div className="attempt" key={a.number}>
                  <code>#{a.number}</code>
                  <strong>{a.outcome}</strong>
                  <span>{time(a.started_at)}</span>
                </div>
              ))
            ) : (
              <p className="muted">No execution has been dispatched.</p>
            )}
            {detail.action.receipt && (
              <>
                <h3>Durable provider receipt</h3>
                <pre>
                  {JSON.stringify(JSON.parse(detail.action.receipt), null, 2)}
                </pre>
              </>
            )}
            <h3>Audit history</h3>
            {activity([...detail.audit].reverse())}
            <div className="modal-actions">
              {detail.action.status === "PENDING_APPROVAL" && (
                <>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      setApproval({ action: detail.action, decision: "reject" })
                    }
                  >
                    Reject
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      setApproval({
                        action: detail.action,
                        decision: "approve",
                      })
                    }
                  >
                    Review & approve
                  </button>
                </>
              )}
              {detail.action.status === "READY" && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void execute(detail.action)}
                >
                  Execute payment
                  <ArrowRight size={15} />
                </button>
              )}
              {["UNKNOWN", "RUNNING"].includes(detail.action.status) && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void recover(detail.action)}
                >
                  Request safe recovery
                  <RefreshCw size={15} />
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => void openDetail(detail.action.id)}
              >
                Refresh
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
