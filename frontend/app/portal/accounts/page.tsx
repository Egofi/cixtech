"use client";

import {
  Badge,
  ErrorState,
  Hint,
  Loading,
  Mono,
  PageHead,
  Panel,
  Table,
} from "@/components/primitives";
import { portal } from "@/lib/api";
import { statusLabel, statusTone } from "@/lib/labels";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { Account, DepositAddress } from "@/types/api";
import { useState } from "react";

export default function Accounts() {
  const q = useApi(() => portal.get<{ accounts: Account[] }>("/v1/accounts?limit=200"), []);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  async function create() {
    setBusy(true);
    try {
      await portal.post("/v1/accounts", ref.trim() ? { externalRef: ref.trim() } : {});
      setRef("");
      q.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Sub-accounts" />
      <Panel title="Create a sub-account">
        <div className="row" style={{ gap: 10 }}>
          <input
            placeholder="Your own reference (optional)"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            maxLength={256}
          />
          <button type="button" className="primary" disabled={busy} onClick={create}>
            Create
          </button>
        </div>
        <Hint>
          One sub-account per merchant or user. Deposit addresses are assigned per account.
        </Hint>
      </Panel>

      <Panel title="Your sub-accounts">
        <Table
          rows={q.data?.accounts ?? []}
          rowKey={(a) => a.id}
          empty="No sub-accounts yet."
          columns={[
            { header: "Account ID", cell: (a) => <Mono value={a.id} truncate={16} /> },
            {
              header: "Your reference",
              cell: (a) => a.externalRef ?? <span className="muted">—</span>,
            },
            { header: "Created", cell: (a) => <span className="muted">{when(a.createdAt)}</span> },
            {
              header: "",
              cell: (a) => (
                <button type="button" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  {open === a.id ? "Hide addresses" : "Deposit addresses"}
                </button>
              ),
            },
          ]}
        />
      </Panel>

      {open ? <Addresses accountId={open} /> : null}
    </>
  );
}

function Addresses({ accountId }: { accountId: string }) {
  const q = useApi(
    () =>
      portal.get<{ addresses: DepositAddress[] }>(`/v1/accounts/${accountId}/deposit-addresses`),
    [accountId],
  );
  const [chain, setChain] = useState("TRON");
  const [busy, setBusy] = useState(false);

  async function assign() {
    setBusy(true);
    try {
      await portal.post(`/v1/accounts/${accountId}/deposit-addresses`, { chain, asset: "USDT" });
      q.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={
        <>
          Deposit addresses · <Mono value={accountId} truncate={14} />
        </>
      }
      actions={
        <>
          <input
            value={chain}
            onChange={(e) => setChain(e.target.value.toUpperCase())}
            style={{ width: 120 }}
          />
          <button type="button" className="primary" disabled={busy} onClick={assign}>
            Assign address
          </button>
        </>
      }
    >
      <Table
        rows={q.data?.addresses ?? []}
        rowKey={(a) => `${a.chain}:${a.address}`}
        empty="No addresses assigned yet."
        columns={[
          { header: "Chain", cell: (a) => a.chain },
          { header: "Address", cell: (a) => <Mono value={a.address} /> },
          {
            header: "State",
            cell: (a) => <Badge tone={statusTone(a.state)}>{statusLabel(a.state)}</Badge>,
          },
        ]}
      />
      <Hint>
        Send only the asset the address was issued for. The commonest way to lose funds is sending
        the wrong token to a correct address.
      </Hint>
    </Panel>
  );
}
