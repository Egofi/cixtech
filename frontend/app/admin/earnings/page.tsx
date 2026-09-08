"use client";

import {
  ErrorState,
  Hint,
  Loading,
  Money,
  Mono,
  PageHead,
  Panel,
  StatGrid,
  Table,
} from "@/components/primitives";
import { admin } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useState } from "react";

interface AssetSummary {
  asset: string;
  feeRevenue: string;
  gasExpense: string;
  netMargin: string;
  unsweptFee: string;
}
interface TenantBreakdown {
  tenantId: string;
  tenantName: string;
  asset: string;
  feeRevenue: string;
}
interface Earnings {
  summary: AssetSummary[];
  tenantBreakdown?: TenantBreakdown[];
}

export default function Earnings() {
  const q = useApi(() => admin.get<Earnings>("/admin/api/earnings"), []);
  const [sweeping, setSweeping] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  const summary = q.data?.summary ?? [];
  const main = summary[0]?.asset ?? "USDT";

  async function sweep() {
    setSweeping(true);
    setResult(null);
    try {
      const res = await admin.post<{ swept?: number; total?: string }>(
        "/admin/api/earnings/sweep",
        { asset: main },
      );
      setResult(`Swept ${res.swept ?? 0} leg(s), ${res.total ?? "0"} base units.`);
      q.reload();
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setSweeping(false);
    }
  }

  return (
    <>
      <PageHead
        title="Earnings & revenue"
        actions={
          <button type="button" className="primary" disabled={sweeping} onClick={sweep}>
            {sweeping ? "Sweeping…" : "Sweep fees to treasury ⚡"}
          </button>
        }
      />
      {result ? <div className="banner warn">{result}</div> : null}

      <StatGrid
        cards={[
          {
            title: "FEE REVENUE",
            value: <Money base={summary[0]?.feeRevenue} asset={main} />,
            sub: "Gross platform fee income",
            icon: "💵",
            color: "green",
          },
          {
            title: "GAS EXPENSE",
            value: <Money base={summary[0]?.gasExpense} asset={main} />,
            sub: "Absorbed network costs",
            icon: "⛽",
            color: "orange",
          },
          {
            title: "NET MARGIN",
            value: <Money base={summary[0]?.netMargin} asset={main} />,
            sub: "Retained after gas",
            icon: "📈",
            color: "cyan",
          },
          {
            title: "UNSWEPT",
            value: <Money base={summary[0]?.unsweptFee} asset={main} />,
            sub: "Accrued, still in pool addresses",
            icon: "🏦",
            color: "purple",
          },
        ]}
      />

      <Panel title="By asset">
        <Table
          rows={summary}
          rowKey={(r) => r.asset}
          empty="No fee revenue recorded yet."
          columns={[
            { header: "Asset", cell: (r) => <b>{r.asset}</b> },
            {
              header: "Fee revenue",
              numeric: true,
              cell: (r) => <Money base={r.feeRevenue} asset={r.asset} />,
            },
            {
              header: "Gas expense",
              numeric: true,
              cell: (r) => <Money base={r.gasExpense} asset={r.asset} />,
            },
            {
              header: "Net margin",
              numeric: true,
              cell: (r) => <Money base={r.netMargin} asset={r.asset} />,
            },
            {
              header: "Unswept",
              numeric: true,
              cell: (r) => <Money base={r.unsweptFee} asset={r.asset} />,
            },
          ]}
        />
        <Hint>
          A sweep is a real on-chain transfer out of pool addresses. It clears the same policy and
          signing-boundary checks a tenant payout does.
        </Hint>
      </Panel>

      <Panel title="By tenant">
        <Table
          rows={q.data?.tenantBreakdown ?? []}
          rowKey={(r) => `${r.tenantId}:${r.asset}`}
          empty="No per-tenant fee revenue yet."
          columns={[
            { header: "Tenant", cell: (r) => <b>{r.tenantName}</b> },
            { header: "Tenant ID", cell: (r) => <Mono value={r.tenantId} truncate={12} /> },
            { header: "Asset", cell: (r) => <span className="muted">{r.asset}</span> },
            {
              header: "Fee contributed",
              numeric: true,
              cell: (r) => <Money base={r.feeRevenue} asset={r.asset} />,
            },
          ]}
        />
      </Panel>
    </>
  );
}
