import type { ReactNode } from 'react';
import { useEffect } from 'react';

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-title">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value tnum">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Banner({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'success' | 'plain';
  children: ReactNode;
}): JSX.Element {
  return <div className={`banner ${kind === 'plain' ? '' : kind}`}>{children}</div>;
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function ProgressBar({ value }: { value: number }): JSX.Element {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <div style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

export interface ToastMessage {
  kind: 'info' | 'error' | 'success';
  text: string;
}

export function Toast({
  message,
  onDismiss,
}: {
  message: ToastMessage | null;
  onDismiss: () => void;
}): JSX.Element | null {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDismiss, message.kind === 'error' ? 9000 : 4500);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div className={`toast ${message.kind}`} role="status">
      <div className="row between">
        <span>{message.text}</span>
        <button type="button" className="subtle" onClick={onDismiss} aria-label="Dismiss">
          {'×'}
        </button>
      </div>
    </div>
  );
}

export function BarList({
  rows,
  max,
}: {
  rows: Array<{ label: string; count: number }>;
  max?: number;
}): JSX.Element {
  const peak = max ?? Math.max(1, ...rows.map((row) => row.count));
  return (
    <div>
      {rows.map((row) => (
        <div className="bar-row" key={row.label}>
          <span title={row.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.label}
          </span>
          <span className="bar-track">
            <span className="bar" style={{ width: `${Math.max(2, (row.count / peak) * 100)}%`, display: 'block' }} />
          </span>
          <span className="muted tnum small">{row.count.toLocaleString('en-US')}</span>
        </div>
      ))}
    </div>
  );
}
