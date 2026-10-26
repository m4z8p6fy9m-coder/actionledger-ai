import { useState } from "react";
import {
  LockKeyhole,
  Plus,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { money, payload, type Action } from "../api";
import { Modal } from "./ui";
export function CreateModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: unknown) => void;
}) {
  const [key, setKey] = useState("pay." + crypto.randomUUID());
  return (
    <Modal title="Create a payment action" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const amount = Number(form.get("amount"));
          onSubmit({
            idempotencyKey: key,
            recipient: String(form.get("recipient")),
            amountCents: Math.round(amount * 100),
            currency: "EUR",
            providerMode: String(form.get("mode")),
            description: String(form.get("description")),
          });
        }}
      >
        <p className="form-intro">
          Record the intent first. A separate human decision is required before
          any payment can execute.
        </p>
        <div className="form-grid">
          <label>
            Recipient
            <input
              name="recipient"
              required
              maxLength={100}
              placeholder="Alice"
              autoFocus
            />
          </label>
          <label>
            Amount (EUR)
            <input
              name="amount"
              type="number"
              required
              min="0.01"
              max="1000000"
              step="0.01"
              defaultValue="10.00"
            />
          </label>
        </div>
        <label>
          Description
          <input
            name="description"
            maxLength={240}
            defaultValue="Agent payment"
          />
        </label>
        <label>
          Idempotency key
          <input
            value={key}
            required
            minLength={8}
            maxLength={128}
            pattern="[a-zA-Z0-9_.:\-]+"
            onChange={(e) => setKey(e.target.value)}
            className="mono"
          />
          <small>
            Reuse this key for the same logical intent. Never generate a new key
            on a retry.
          </small>
        </label>
        <label>
          Provider policy
          <select name="mode" defaultValue="idempotent">
            <option value="idempotent">Provider-enforced idempotency</option>
            <option value="unprotected">
              No idempotency · uncertain actions freeze
            </option>
          </select>
        </label>
        <div className="info-strip">
          <LockKeyhole size={16} />
          <span>
            Simulated local payment. High-risk approval policy is enforced by
            the server.
          </span>
        </div>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy} type="submit">
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Plus size={16} />
            )}
            Record action
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ApprovalModal({
  action,
  decision,
  busy,
  onClose,
  onSubmit,
}: {
  action: Action;
  decision: "approve" | "reject";
  busy: boolean;
  onClose: () => void;
  onSubmit: (actor: string, reason: string) => void;
}) {
  const p = payload(action);
  return (
    <Modal
      title={
        decision === "approve" ? "Review & approve payment" : "Reject payment"
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          onSubmit(String(f.get("actor")), String(f.get("reason")));
        }}
      >
        <div className="review-amount">
          {money(p.amountCents)}
          <span>to {p.recipient}</span>
        </div>
        <div className="review-policy">
          <ShieldAlert size={17} />
          {p.providerMode === "idempotent"
            ? "The provider enforces idempotency for this key."
            : "No provider idempotency. A crash will require manual investigation."}
        </div>
        <code className="key-block">{action.idempotency_key}</code>
        <label>
          Your name
          <input
            name="actor"
            required
            maxLength={80}
            placeholder="Reviewer name"
            autoFocus
          />
        </label>
        <label>
          Decision reason
          <textarea
            name="reason"
            required
            maxLength={300}
            rows={3}
            placeholder="Why are you approving or rejecting this exact payment?"
          />
        </label>
        <p className="form-intro">
          This decision is final and persists across restarts. Approval permits
          execution; it does not send the payment.
        </p>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={
              "button " + (decision === "approve" ? "primary" : "crash-button")
            }
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ShieldCheck size={16} />
            )}
            Confirm {decision === "approve" ? "approval" : "rejection"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
