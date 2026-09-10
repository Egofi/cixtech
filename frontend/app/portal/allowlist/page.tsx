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
import { ApiError, portal } from "@/lib/api";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { AllowlistEntry } from "@/types/api";
import { useState } from "react";

export default function Allowlist() {
  const q = useApi(
    () => portal.get<{ allowlist: AllowlistEntry[] }>("/v1/allowlist?limit=200"),
    [],
  );
  const [form, setForm] = useState({ account: "", chain: "TRON", address: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  async function add() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await portal.post<{ usableAt: string }>(
        `/v1/accounts/${form.account}/allowlist`,
        {
          chain: form.chain,
          address: form.address,
        },
      );
      setNotice(
        `Added. Usable from ${when(res.usableAt)} — the cool-down is what defeats add-and-drain.`,
      );
      q.reload();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: AllowlistEntry) {
    setBusy(true);
    try {
      await portal.del(
        `/v1/accounts/${e.accountId}/allowlist?chain=${encodeURIComponent(e.chain)}&address=${encodeURIComponent(e.address)}`,
      );
      q.reload();
    } finally {
      setBusy(false);
    }
  }

  const now = Date.now();

  return (
    <>
      <PageHead title="Payout allow-list" />

      <Panel title="Add a destination">
        {notice ? <div className="banner warn">{notice}</div> : null}
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
            placeholder="Destination address"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
          <button type="button" className="primary" disabled={busy} onClick={add}>
            Add destination
          </button>
        </div>
        <Hint>
          A freshly added address is unusable until its cool-down elapses. Remove one the moment you
          believe it is compromised — removal takes effect immediately.
        </Hint>
      </Panel>

      <Panel title="Allow-listed destinations">
        <Table
          rows={q.data?.allowlist ?? []}
          rowKey={(e) => `${e.accountId}:${e.chain}:${e.address}`}
          empty="No destinations allow-listed. A payout cannot be sent until one is."
          columns={[
            { header: "Account", cell: (e) => <Mono value={e.accountId} truncate={12} /> },
            { header: "Chain", cell: (e) => e.chain },
            { header: "Address", cell: (e) => <Mono value={e.address} truncate={20} /> },
            {
              header: "Usable",
              cell: (e) =>
                new Date(e.usableAt).getTime() <= now ? (
                  <Badge tone="ok">Usable now</Badge>
                ) : (
                  <Badge tone="warn">from {when(e.usableAt)}</Badge>
                ),
            },
            {
              header: "",
              cell: (e) => (
                <button type="button" className="danger" disabled={busy} onClick={() => remove(e)}>
                  Remove
                </button>
              ),
            },
          ]}
        />
      </Panel>
    </>
  );
}
