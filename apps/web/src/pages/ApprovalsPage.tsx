import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ShieldCheck,
  LoaderCircle,
  TriangleAlert,
  RefreshCw,
} from "lucide-react";
import { money, payload, type Action } from "../api";
import { useActionPage } from "../hooks/useActionPage";
import { Badge, Empty } from "../components/ui";
import { Pagination } from "../components/Pagination";
export function ApprovalsPage({
  revision,
  busy,
  onReview,
}: {
  revision: number | null;
  busy: boolean;
  onReview: (action: Action, decision: "approve" | "reject") => void;
}) {
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(12);
  const { page, loading, error, retry } = useActionPage(
    { status: "PENDING_APPROVAL", sort: "oldest", offset, limit },
    revision,
  );
  useEffect(() => {
    if (page && offset > 0 && offset >= page.total)
      setOffset(Math.max(0, Math.floor((page.total - 1) / limit) * limit));
  }, [page, offset, limit]);
  return (
    <>
      <div className="info-strip">
        <ShieldCheck size={18} />
        <span>
          Approval authorizes an immutable intent. It does not prove external
          completion. Oldest pending decisions appear first.
        </span>
      </div>
      <div className="queue-heading">
        <h2>
          Human review queue{" "}
          <span className="count-label">{page?.total ?? "…"}</span>
        </h2>
        <span>All pending actions · across the complete ledger</span>
      </div>
      {error && (
        <div className="list-error" role="alert">
          <TriangleAlert size={17} />
          <span>{error}</span>
          <button className="text-button" onClick={retry}>
            <RefreshCw size={14} />
            Retry read
          </button>
        </div>
      )}
      {loading && !page && (
        <div className="list-loading" role="status">
          <LoaderCircle size={20} className="spin" />
          Loading pending decisions…
        </div>
      )}
      <div className="approval-grid" aria-busy={loading}>
        {page?.items.map((action) => {
          const payment = payload(action);
          return (
            <section className="panel approval-card" key={action.id}>
              <div className="approval-top">
                <span className="action-icon">
                  <ArrowUpRight size={20} />
                </span>
                <Badge status={action.status} />
              </div>
              <h2>
                {money(payment.amountCents)} <span>to {payment.recipient}</span>
              </h2>
              <p>{payment.description}</p>
              <code className="key-block">{action.idempotency_key}</code>
              <div className="safety-row">
                <span>Risk level</span>
                <span className="risk">HIGH · Explicit review</span>
              </div>
              <div className="safety-row">
                <span>Provider protection</span>
                <span>
                  {payment.providerMode === "idempotent"
                    ? "Enforced idempotency"
                    : "None · uncertain outcomes freeze"}
                </span>
              </div>
              <div className="approval-age">
                <time dateTime={action.created_at}>
                  Requested {new Date(action.created_at).toLocaleString()}
                </time>
              </div>
              <div className="approval-buttons">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => onReview(action, "reject")}
                >
                  Reject
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => onReview(action, "approve")}
                >
                  <ShieldCheck size={15} />
                  Review & approve
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {page?.total === 0 && !error && (
        <section className="panel">
          <Empty
            title="No decisions waiting"
            description="All payment intents have been reviewed. New actions appear here before they can execute."
          />
        </section>
      )}
      {page && page.total > 0 && (
        <Pagination
          offset={offset}
          limit={limit}
          total={page.total}
          loading={loading}
          onOffset={setOffset}
          onLimit={(n) => {
            setLimit(n);
            setOffset(0);
          }}
          sizes={[6, 12, 24]}
        />
      )}
    </>
  );
}
