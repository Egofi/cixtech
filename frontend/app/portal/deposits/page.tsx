"use client";

import {
  Badge,
  ErrorState,
  Loading,
  Money,
  Mono,
  PageHead,
  Panel,
  Table,
} from "@/components/primitives";
import { portal } from "@/lib/api";
import { kindLabel, kindTone } from "@/lib/labels";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { Deposit } from "@/types/api";

export default function Deposits() {
  const q = useApi(() => portal.get<{ deposits: Deposit[] }>("/v1/deposits?limit=100"), []);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  return (
    <>
      <PageHead title="Deposits" />
      <Panel title="What came in, and what you were credited">
        <Table
          rows={q.data?.deposits ?? []}
          rowKey={(d) => d.id}
          empty="No deposits yet."
          columns={[
            { header: "When", cell: (d) => <span className="muted">{when(d.occurredAt)}</span> },
            {
              header: "Event",
              cell: (d) => <Badge tone={kindTone(d.kind)}>{kindLabel(d.kind)}</Badge>,
            },
            {
              header: "Account",
              cell: (d) =>
                d.accountId ? (
                  <Mono value={d.accountId} truncate={12} />
                ) : (
                  <span className="muted">held</span>
                ),
            },
            {
              header: "Received",
              numeric: true,
              cell: (d) => <Money base={d.grossAmount} asset={d.asset} />,
            },
            {
              header: "Fee",
              numeric: true,
              cell: (d) => (
                <>
                  <Money base={d.feeCollected} asset={d.asset} />{" "}
                  <span className="muted">({d.feePercent})</span>
                </>
              ),
            },
            {
              header: "Credited",
              numeric: true,
              cell: (d) => <Money base={d.netCredited} asset={d.asset} />,
            },
          ]}
        />
      </Panel>
    </>
  );
}
