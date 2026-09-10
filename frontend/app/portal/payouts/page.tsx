"use client";

import {
  ErrorState,
  Hint,
  Loading,
  Money,
  Mono,
  PageHead,
  Panel,
  StatusBadge,
  Table,
} from "@/components/primitives";
import { ApiError, portal } from "@/lib/api";
import { toBaseUnits, when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { HeldWithdrawal, Payout } from "@/types/api";
import { useState } from "react";

export default function Payouts() {
  const q = useApi(() => portal.get<{ payouts: Payout[] }>("/v1/payouts?limit=100"), []);
  const [form, setForm] = useState({
    account: "",
    chain: "TRON",
    asset: "USDT",
    amount: "",
    destination: "",
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  async function submit() {
    const base = toBaseUnits(form.amount, form.asset);
    if (!base || base === "0") {
      setNotice({
        tone: "bad",

        text: `“${form.amount}” is not a valid ${form.asset} amount. Check the number of decimal places.`,
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const key = crypto.randomUUID();
      const res = await portal.post<{ txId?: string } & Partial<HeldWithdrawal>>(
        `/v1/accounts/${form.account}/withdrawals`,
        { chain: form.chain, asset: form.asset, amount: base, destination: form.destination },
        { "idempotency-key": key },
      );
      setNotice(
        res.withdrawalId
          ? {
              tone: "warn",
              text: `Held for approval (${res.status}). Withdrawal ${res.withdrawalId}.`,
            }
          : { tone: "ok", text: `Sent. Transaction ${res.txId}.` },
      );
      q.reload();
    } catch (err) {
      setNotice({ tone: "bad", text: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Payouts" />

      <Panel title="Request a payout">
        {notice ? <div className={`banner ${notice.tone}`}>{notice.text}</div> : null}
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <input
            placeholder="Account ID"
            value={form.account}
            onChange={(e) => setForm({ ...form, account: e.target.value })}
          />
          <input
            placeholder="Chain"
            value={form.chain}
            onChange={(e) => setForm({ ...form, chain: e.target.value.toUpperCase() })}
            style={{ width: 110 }}
          />
          <input
            placeholder="Asset"
            value={form.asset}
            onChange={(e) => setForm({ ...form, asset: e.target.value.toUpperCase() })}
            style={{ width: 100 }}
          />
          <input
            placeholder="Amount, e.g. 4.34"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            style={{ width: 140 }}
          />
          <input
            placeholder="Destination address"
            value={form.destination}
            onChange={(e) => setForm({ ...form, destination: e.target.value })}
          />
          <button type="button" className="primary" disabled={busy} onClick={submit}>
            {busy ? "Sending…" : "Request payout"}
          </button>
        </div>
        <Hint>
          The destination must already be on your allow-list and past its cool-down. Amounts above
          your approval threshold are held until a second credential signs off.
        </Hint>
      </Panel>

      <Panel title="History">
        <Table
          rows={q.data?.payouts ?? []}
          rowKey={(p) => p.idempotencyKey}
          empty="No payouts yet."
          columns={[
            { header: "When", cell: (p) => <span className="muted">{when(p.createdAt)}</span> },
            { header: "Account", cell: (p) => <Mono value={p.accountId} truncate={12} /> },
            {
              header: "Amount",
              numeric: true,
              cell: (p) => <Money base={p.amount} asset={p.asset} />,
            },
            { header: "Destination", cell: (p) => <Mono value={p.destination} truncate={16} /> },
            { header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
            {
              header: "Transaction",
              cell: (p) =>
                p.txId ? <Mono value={p.txId} truncate={16} /> : <span className="muted">—</span>,
            },
          ]}
        />
      </Panel>
    </>
  );
}
