import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Search,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, labels, type Status } from "../api";
import {
  actionQuery,
  useActionPage,
  useDebouncedValue,
} from "../hooks/useActionPage";
import { ActionsTable } from "../components/ActionsTable";
import { Pagination } from "../components/Pagination";
export function ActionsPage({
  initialStatus,
  revision,
  counts,
  busy,
  onInspect,
  onCreate,
  onNotice,
}: {
  initialStatus: string;
  revision: number | null;
  counts: { status: Status; count: number }[];
  busy: boolean;
  onInspect: (id: string) => void;
  onCreate: () => void;
  onNotice: (text: string, error?: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim());
  const [status, setStatus] = useState(initialStatus);
  const [sort, setSort] = useState("newest");
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(25);
  const [exporting, setExporting] = useState(false);
  const { page, loading, error, retry } = useActionPage(
    { q: debounced, status, sort, offset, limit },
    revision,
  );
  useEffect(() => {
    if (page && offset > 0 && offset >= page.total)
      setOffset(Math.max(0, Math.floor((page.total - 1) / limit) * limit));
  }, [page, offset, limit]);
  function changeStatus(next: string) {
    setStatus(next);
    setOffset(0);
  }
  async function exportCsv() {
    setExporting(true);
    try {
      const csv = await api<string>(
        "/actions/export?" + actionQuery({ q: debounced, status, sort }),
      );
      const url = URL.createObjectURL(
        new Blob([csv.startsWith("\uFEFF") ? csv : "\uFEFF" + csv], {
          type: "text/csv;charset=utf-8",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "actionledger-actions.csv";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onNotice(
        "Filtered ledger exported, including results beyond the current page.",
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Export failed.", true);
    } finally {
      setExporting(false);
    }
  }
  const tabs = [
    {
      label: "All actions",
      status: "ALL",
      count: counts.reduce((sum, row) => sum + Number(row.count), 0),
    },
    {
      label: "Needs approval",
      status: "PENDING_APPROVAL",
      count: Number(
        counts.find((row) => row.status === "PENDING_APPROVAL")?.count ?? 0,
      ),
    },
    {
      label: "Uncertain outcomes",
      status: "UNKNOWN",
      count: Number(counts.find((row) => row.status === "UNKNOWN")?.count ?? 0),
    },
    {
      label: "Completed",
      status: "SUCCEEDED",
      count: Number(
        counts.find((row) => row.status === "SUCCEEDED")?.count ?? 0,
      ),
    },
  ];
  return (
    <section className="panel registry-panel">
      <div className="panel-heading">
        <div>
          <div className="section-kicker">PERSISTENT ACTION REGISTRY</div>
          <h2>Every intent, in one place</h2>
          <p>
            Search the complete ledger. Filter precisely. Keep the evidence.
          </p>
        </div>
        <button
          className="button secondary small-button"
          disabled={busy || exporting || query.trim() !== debounced}
          onClick={() => void exportCsv()}
        >
          {exporting ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <ArrowDownToLine size={15} />
          )}{" "}
          {exporting ? "Preparing export…" : "Export filtered CSV"}
        </button>
      </div>
      <div
        className="registry-tabs"
        role="group"
        aria-label="Quick status filters"
      >
        {tabs.map((tab) => (
          <button
            key={tab.status}
            aria-pressed={status === tab.status}
            className={status === tab.status ? "selected" : ""}
            onClick={() => changeStatus(tab.status)}
          >
            {tab.label}
            <span>{tab.count}</span>
          </button>
        ))}
      </div>
      <div className="table-tools registry-tools">
        <div className="search">
          <Search size={17} />
          <input
            aria-label="Search actions"
            placeholder="Search payee, description, key, or action ID…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="Clear action search"
              onClick={() => {
                setQuery("");
                setOffset(0);
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <select
          aria-label="Filter action status"
          value={status}
          onChange={(e) => changeStatus(e.target.value)}
        >
          <option value="ALL">All statuses</option>
          {Object.entries(labels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort actions"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setOffset(0);
          }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      {error && (
        <div className="list-error" role="alert">
          <TriangleAlert size={17} />
          <span>
            {error} {page ? "Showing the last successful result." : ""}
          </span>
          <button className="text-button" onClick={retry}>
            <RefreshCw size={14} />
            Retry read
          </button>
        </div>
      )}
      {loading && !page ? (
        <div className="list-loading" role="status">
          <LoaderCircle size={20} className="spin" />
          Loading ledger records…
        </div>
      ) : error && !page ? null : (
        <ActionsTable
          items={page?.items ?? []}
          busy={busy}
          loading={loading}
          filtered={Boolean(debounced) || status !== "ALL"}
          onInspect={onInspect}
          onCreate={onCreate}
        />
      )}
      {page && (
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
        />
      )}
    </section>
  );
}
