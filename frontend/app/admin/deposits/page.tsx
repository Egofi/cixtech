"use client";

import {
  Badge,
  ErrorState,
  Loading,
  Mono,
  PageHead,
  Panel,
  StatGrid,
  Table,
} from "@/components/primitives";
import { admin } from "@/lib/api";
import { kindLabel, kindTone } from "@/lib/labels";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";

interface Row {
  id: string;
  kind: string;
  occurredAt: string;
  tenant?: string;
}

export default function Deposits() {
  const q = useApi(() => admin.get<Row[]>("/admin/api/deposits?limit=100"), []);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  const rows = q.data ?? [];

  const count = (k: string) => rows.filter((r) => r.kind === k).length;
  const pending = rows.length - count("deposit.finalized") - count("deposit.quarantined");

  return (
    <>
      <PageHead title="On-chain deposits" />
      <StatGrid
        cards={[
          {
            title: "TOTAL DEPOSITS",
            value: rows.length,
            sub: "Recent incoming deposits",
            icon: "📥",
          },
          {
            title: "CREDITED",
            value: count("deposit.finalized"),
            sub: "Credited to merchant accounts",
            icon: "✅",
            color: "green",
          },
          {
            title: "CONFIRMING",
            value: pending,
            sub: "Awaiting block confirmations",
            icon: "⏳",
            color: "purple",
          },
          {
            title: "HELD FOR REVIEW",
            value: count("deposit.quarantined"),
            sub: "Flagged by compliance",
            icon: "🚨",
            color: "orange",
          },
        ]}
      />
      <Panel title="Incoming deposit feed">
        <Table
          rows={rows}
          rowKey={(r) => r.id}
          empty="No deposits detected yet."
          columns={[
            { header: "When", cell: (r) => <span className="muted">{when(r.occurredAt)}</span> },
            {
              header: "Event",
              cell: (r) => <Badge tone={kindTone(r.kind)}>{kindLabel(r.kind)}</Badge>,
            },
            { header: "Entry", cell: (r) => <Mono value={r.id} truncate={28} /> },
          ]}
        />
      </Panel>
    </>
  );
}
