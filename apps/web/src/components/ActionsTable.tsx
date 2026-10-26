import {
  ArrowUpRight,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { money, payload, time, type Action } from "../api";
import { Badge, Empty } from "./ui";
export function ActionsTable({
  items,
  busy = false,
  loading = false,
  filtered = false,
  onInspect,
  onCreate,
}: {
  items: Action[];
  busy?: boolean;
  loading?: boolean;
  filtered?: boolean;
  onInspect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="table-scroll" aria-busy={loading}>
      <table>
        <thead>
          <tr>
            <th scope="col">Action / idempotency key</th>
            <th scope="col">Provider policy</th>
            <th scope="col">Amount</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Created</th>
            <th scope="col" aria-label="Details" />
          </tr>
        </thead>
        <tbody>
          {items.map((action) => {
            const payment = payload(action);
            return (
              <tr key={action.id} onClick={() => !busy && onInspect(action.id)}>
                <td>
                  <div className="action-cell">
                    <span className="action-icon">
                      <ArrowUpRight size={17} />
                    </span>
                    <span>
                      <strong>Payment to {payment.recipient}</strong>
                      <code title={action.idempotency_key}>
                        {action.idempotency_key}
                      </code>
                    </span>
                  </div>
                </td>
                <td>
                  <span
                    className={
                      "policy " +
                      (payment.providerMode === "idempotent"
                        ? "protected"
                        : "exposed")
                    }
                  >
                    {payment.providerMode === "idempotent" ? (
                      <ShieldCheck size={13} />
                    ) : (
                      <ShieldAlert size={13} />
                    )}{" "}
                    {payment.providerMode === "idempotent"
                      ? "Idempotent"
                      : "Unprotected"}
                  </span>
                </td>
                <td className="money">{money(payment.amountCents)}</td>
                <td>
                  <Badge status={action.status} />
                </td>
                <td className="muted mono">
                  {String(action.attempts).padStart(2, "0")}
                </td>
                <td className="muted mono small">
                  <time
                    dateTime={action.created_at}
                    title={new Date(action.created_at).toLocaleString()}
                  >
                    {time(action.created_at)}
                  </time>
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={"Inspect payment to " + payment.recipient}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      onInspect(action.id);
                    }}
                  >
                    <ChevronRight size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length === 0 && !loading && (
        <Empty
          title={filtered ? "No matching actions" : "Your ledger starts here"}
          description={
            filtered
              ? "Try another search or status filter. Search includes the complete persistent ledger."
              : "Create a payment action or open the crash lab to record your first durable intent."
          }
          action={
            !filtered ? (
              <button className="button secondary" onClick={onCreate}>
                Create an action
              </button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
