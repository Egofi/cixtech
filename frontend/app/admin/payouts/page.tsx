"use client";

import {
  ErrorState,
  Loading,
  Money,
  Mono,
  PageHead,
  Panel,
  StatGrid,
  StatusBadge,
  Table,
} from "@/components/primitives";
import { admin } from "@/lib/api";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";

interface Row {
  idempotencyKey: string;
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: string;
  destination: string;
  status: string;
  txId: string | null;
  createdAt: string;
}

export default function Payouts() {
  const q = useApi(() => admin.get<Row[]>("/admin/api/payouts?limit=100"), []);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  const rows = q.data ?? [];
  const n = (s: string) => rows.filter((r) => r.status === s).length;

  return (
    <>
      <PageHead title="Payouts" />
      <StatGrid
        cards={[
          {
            title: "TOTAL PAYOUTS",
            value: rows.length,
            sub: "Recent money-out requests",
            icon: "📤",
          },
          {
            title: "CONFIRMED",
            value: n("settled"),
            sub: "Settled on chain",
            icon: "✅",
            color: "green",
          },
          {
            title: "IN FLIGHT",
            value: rows.length - n("settled") - n("failed"),
            sub: "Locked, sending or awaiting approval",
            icon: "⏳",
            color: "purple",
          },
          {
            title: "FAILED",
            value: n("failed"),
            sub: "Refused or broadcast failure",
            icon: "⚠",
            color: "orange",
          },
        ]}
      />
      <Panel title="Money-out feed">
        <Table
          rows={rows}
          rowKey={(r) => r.idempotencyKey}
          empty="No payouts requested yet."
          columns={[
            { header: "When", cell: (r) => <span className="muted">{when(r.createdAt)}</span> },
            { header: "Chain", cell: (r) => r.chain },
            {
              header: "Amount",
              numeric: true,
              cell: (r) => <Money base={r.amountBaseUnits} asset={r.asset} />,
            },
            { header: "Destination", cell: (r) => <Mono value={r.destination} truncate={16} /> },
            { header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
            {
              header: "Transaction",
              cell: (r) =>
                r.txId ? <Mono value={r.txId} truncate={16} /> : <span className="muted">—</span>,
            },
          ]}
        />
      </Panel>
    </>
  );
}
