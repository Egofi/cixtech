"use client";

import { type Tone, statusLabel, statusTone } from "@/lib/labels";
import { money, moneyParts } from "@/lib/money";
import type { ReactNode } from "react";

export function Panel({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      {(title || actions) && (
        <h3>
          {title}
          {actions ? <span className="row">{actions}</span> : null}
        </h3>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

export function Money({ base, asset }: { base: string | null | undefined; asset?: string }) {
  const { text, raw } = moneyParts(base, asset);
  return (
    <span className={raw ? "mono muted" : "mono"} title={`${base ?? "0"} base units`}>
      {text}
      {asset && !raw ? <span className="muted"> {asset}</span> : null}
    </span>
  );
}

export function Mono({
  value,
  truncate = 0,
}: { value: string | null | undefined; truncate?: number }) {
  const v = String(value ?? "");
  const shown = truncate > 0 && v.length > truncate ? `${v.slice(0, truncate)}…` : v;
  return (
    <span className="mono" title={v}>
      {shown}
    </span>
  );
}

export interface Column<T> {
  header: ReactNode;

  numeric?: boolean;
  cell: (row: T, index: number) => ReactNode;
}

export function Table<T>({
  columns,
  rows,
  empty = "Nothing here yet.",
  rowKey,
  rowClass,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  empty?: ReactNode;
  rowKey: (row: T, index: number) => string;
  rowClass?: (row: T) => string | undefined;
}) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static column list
              <th key={i} className={c.numeric ? "num" : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)} className={rowClass?.(row)}>
              {columns.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static column list
                <td key={j} className={c.numeric ? "num" : undefined}>
                  {c.cell(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface StatCard {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: string;
  color?: "cyan" | "green" | "purple" | "orange";
}

const DEFAULT_COLORS = ["cyan", "green", "purple", "orange"] as const;

export function StatGrid({ cards }: { cards: readonly StatCard[] }) {
  return (
    <div className="nexis-cards">
      {cards.map((c, i) => (
        <div key={c.title} className={`nexis-card ${c.color ?? DEFAULT_COLORS[i % 4]}`}>
          <div className="nexis-card-head">
            <div className="icon-box">{c.icon ?? "📈"}</div>
            <span>{c.title}</span>
          </div>
          <div className="nexis-card-val">{c.value}</div>
          {c.sub ? <div className="nexis-sub-desc">{c.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <div className={`banner ${tone}`}>{children}</div>;
}

export function PageHead({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="head">
      <h2>{title}</h2>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="banner bad">
      <strong>{error.message}</strong>
      {retry ? (
        <>
          {" "}
          <button type="button" onClick={retry}>
            Try again
          </button>
        </>
      ) : null}
    </div>
  );
}

export { money };
