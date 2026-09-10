"use client";

import {
  ErrorState,
  Loading,
  Money,
  Mono,
  PageHead,
  Panel,
  StatGrid,
  Table,
} from "@/components/primitives";
import { portal } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import type { Account, Balance } from "@/types/api";

export default function PortalOverview() {
  const q = useApi(
    () =>
      Promise.all([
        portal.get<{ balances: Balance[] }>("/v1/balances"),
        portal.get<{ accounts: Account[] }>("/v1/accounts?limit=200"),
      ]),
    [],
  );

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!q.data) return null;

  const [{ balances }, { accounts }] = q.data;
  const assets = [...new Set(balances.map((b) => b.asset))];

  return (
    <>
      <PageHead title="Overview" />
      <StatGrid
        cards={[
          {
            title: "SUB-ACCOUNTS",
            value: accounts.length,
            sub: "Your merchants and users",
            icon: "◧",
          },
          {
            title: "ASSETS HELD",
            value: assets.length,
            sub: assets.join(", ") || "none yet",
            icon: "🏦",
            color: "green",
          },
          {
            title: "BALANCE ROWS",
            value: balances.length,
            sub: "Account × asset combinations",
            icon: "≡",
            color: "purple",
          },
        ]}
      />
      <Panel title="Available balances">
        <Table
          rows={balances}
          rowKey={(b) => `${b.accountId}:${b.asset}`}
          empty="No balances yet. Assign a deposit address and send funds to it."
          columns={[
            { header: "Account", cell: (b) => <Mono value={b.accountId} truncate={14} /> },
            { header: "Asset", cell: (b) => <b>{b.asset}</b> },
            {
              header: "Available",
              numeric: true,
              cell: (b) => <Money base={b.available} asset={b.asset} />,
            },
          ]}
        />
      </Panel>
    </>
  );
}
