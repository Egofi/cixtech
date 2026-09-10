"use client";

import {
  Badge,
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
import { statusLabel, statusTone } from "@/lib/labels";
import { ago } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { PoolAddressRow } from "@/types/api";
import { useState } from "react";

interface PoolsResponse {
  rows: PoolAddressRow[];
  total: string;
  asset: string;
}

export default function Pools() {
  const [fundedOnly, setFundedOnly] = useState(false);
  const q = useApi(
    () =>
      admin.get<PoolsResponse>(
        `/admin/api/pool-addresses?limit=200${fundedOnly ? "&funded=true" : ""}`,
      ),
    [fundedOnly],
  );

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  const rows = q.data?.rows ?? [];
  const asset = q.data?.asset ?? "USDT";
  const funded = rows.filter((r) => r.balance && r.balance !== "0").length;

  return (
    <>
      <PageHead
        title="Pool addresses"
        actions={
          <button
            type="button"
            className={fundedOnly ? "primary" : ""}
            onClick={() => setFundedOnly((v) => !v)}
          >
            {fundedOnly ? "Showing funded only" : "Show funded only"}
          </button>
        }
      />

      <StatGrid
        cards={[
          {
            title: "POOL ADDRESSES",
            value: q.data?.total ?? "0",
            sub: `${funded} holding a balance`,
            icon: "👛",
          },
          {
            title: "IN USE",
            value: rows.filter((r) => r.state === "IN_USE").length,
            sub: "Assigned to a merchant",
            icon: "◧",
            color: "green",
          },
          {
            title: "COOLING",
            value: rows.filter((r) => r.state === "COOLING").length,
            sub: "Waiting to be reused",
            icon: "⏳",
            color: "purple",
          },
          {
            title: "AVAILABLE",
            value: rows.filter((r) => r.state === "AVAILABLE").length,
            sub: "Ready to assign",
            icon: "✅",
            color: "orange",
          },
        ]}
      />

      <Panel title="Every address the engine controls">
        <Table
          rows={rows}
          rowKey={(r) => `${r.chain}:${r.address}`}
          empty="No pool addresses minted yet."
          columns={[
            { header: "Address", cell: (r) => <Mono value={r.address} truncate={16} /> },
            { header: "Chain", cell: (r) => r.chain },
            { header: "Merchant", cell: (r) => <Mono value={r.merchant} truncate={12} /> },
            {
              header: "State",
              cell: (r) => <Badge tone={statusTone(r.state)}>{statusLabel(r.state)}</Badge>,
            },
            {
              header: `Balance (${asset})`,
              numeric: true,
              cell: (r) =>
                r.balance == null ? (
                  <span className="muted" title="Never observed — not the same as zero">
                    not observed
                  </span>
                ) : (
                  <Money base={r.balance} asset={asset} />
                ),
            },
            { header: "Seen", cell: (r) => <span className="muted">{ago(r.observedAt)}</span> },
          ]}
        />
        <Hint>
          A balance shown as <em>not observed</em> has never been read from the chain. That is not
          the same as zero, and the difference matters when reconciling.
        </Hint>
      </Panel>
    </>
  );
}
