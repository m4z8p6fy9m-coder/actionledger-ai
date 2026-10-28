import React, { useEffect, useRef } from "react";
import { Activity, Database, X, Check } from "lucide-react";
import { labels, type Status } from "../api";
export const Badge = ({ status }: { status: Status }) => (
  <span className={"badge " + status.toLowerCase()}>
    <span />
    {labels[status]}
  </span>
);
export const Empty = ({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) => (
  <div className="empty">
    <Database size={28} />
    <h3>{title}</h3>
    <p>{description}</p>
    {action}
  </div>
);
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      aria-label={title}
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ModalError({ message }: { message?: string }) {
  return message ? (
    <div className="modal-error" role="alert">
      {message}
    </div>
  ) : null;
}
export function Metric({
  label,
  value,
  icon: Icon,
  footer,
  accent = "",
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  footer: string;
  accent?: string;
}) {
  return (
    <section className={"metric " + accent}>
      <div>
        <span>{label}</span>
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      <p>
        <span />
        {footer}
      </p>
    </section>
  );
}
export function LabStep({
  number,
  title,
  description,
  done,
  children,
}: {
  number: string;
  title: string;
  description: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={"lab-step " + (done ? "done" : "")}>
      <span className="step-number">{done ? <Check size={17} /> : number}</span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
        {children}
      </div>
    </div>
  );
}
