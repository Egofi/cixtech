"use client";

import { ErrorState, Loading, Money, Mono, PageHead, Panel, Table } from "@/components/primitives";
import { Badge } from "@/components/primitives";
import { admin } from "@/lib/api";
import { accountName, kindLabel, kindTone } from "@/lib/labels";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";

interface AccountBalance {
  account: string;
  asset: string;
  balance: string;
  type?: string;
}
interface Entry {
  id: string;
  kind: string;
  occurredAt: string;
  postings?: Array<{ account: string; asset: string; amount: string; direction: string }>;
}

export default function Ledger() {
  const q = useApi(
    () =>
      Promise.all([
        admin.get<AccountBalance[]>("/admin/api/ledger/accounts"),
        admin.get<Entry[]>("/admin/api/ledger/entries?limit=80"),
      ]),
    [],
  );

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!q.data) return null;
  const [accounts, entries] = q.data;

  return (
    <>
      <PageHead title="Double-entry ledger" />

      <Panel title="Account balances">
        <Table
          rows={accounts}
          rowKey={(a) => `${a.account}:${a.asset}`}
          empty="No balances recorded."
          columns={[
            {
              header: "Account",
              cell: (a) => (
                <>
                  {accountName(a.account)} <Mono value={a.account} truncate={0} />
                </>
              ),
            },
            { header: "Asset", cell: (a) => <span className="muted">{a.asset}</span> },
            {
              header: "Balance",
              numeric: true,
              cell: (a) => <Money base={a.balance} asset={a.asset} />,
            },
          ]}
        />
      </Panel>

      <Panel title="Recent sub-ledger activity">
        <Table
          rows={entries}
          rowKey={(e) => e.id}
          empty="No journal entries yet."
          columns={[
            { header: "When", cell: (e) => <span className="muted">{when(e.occurredAt)}</span> },
            {
              header: "Event",
              cell: (e) => <Badge tone={kindTone(e.kind)}>{kindLabel(e.kind)}</Badge>,
            },
            { header: "Entry", cell: (e) => <Mono value={e.id} truncate={24} /> },
          ]}
        />
      </Panel>
    </>
  );
}
