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
import { admin } from "@/lib/api";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { ApiKeySummary, Scope, TenantSummary } from "@/types/api";
import { useState } from "react";

const ALL_SCOPES: Scope[] = ["read", "move-funds", "approve"];

export default function Tenants() {
  const q = useApi(() => admin.get<TenantSummary[]>("/admin/api/tenants"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    tenantId: string;
    apiKey: string;
    scopes: Scope[];
  } | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  return (
    <>
      <PageHead title="Tenants" />
      <Panel title="Every tenant on this engine">
        <Table
          rows={q.data ?? []}
          rowKey={(t) => t.id}
          empty="No tenants yet."
          columns={[
            { header: "Name", cell: (t) => <b>{t.name}</b> },
            { header: "Tenant ID", cell: (t) => <Mono value={t.id} truncate={12} /> },
            { header: "Created", cell: (t) => <span className="muted">{when(t.createdAt)}</span> },
            {
              header: "",
              cell: (t) => (
                <button type="button" onClick={() => setSelected(t.id)}>
                  Credentials
                </button>
              ),
            },
          ]}
        />
      </Panel>

      {issued ? (
        <Panel title="New credential — shown once">
          <div className="banner warn">
            This key is displayed once and never again. The engine stores only its hash.
          </div>
          <p className="mono" style={{ wordBreak: "break-all" }}>
            {issued.apiKey}
          </p>
          <Hint>Scopes: {issued.scopes.join(", ")}</Hint>
          <button type="button" onClick={() => setIssued(null)}>
            Done
          </button>
        </Panel>
      ) : null}

      {selected ? <TenantKeys tenantId={selected} onIssued={setIssued} /> : null}
    </>
  );
}

function TenantKeys({
  tenantId,
  onIssued,
}: {
  tenantId: string;
  onIssued: (v: { tenantId: string; apiKey: string; scopes: Scope[] }) => void;
}) {
  const q = useApi(
    () =>
      admin.get<{ tenantId: string; keys: ApiKeySummary[] }>(`/admin/api/tenants/${tenantId}/keys`),
    [tenantId],
  );
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [busy, setBusy] = useState(false);

  async function issue() {
    setBusy(true);
    try {
      const res = await admin.post<{ tenantId: string; apiKey: string; scopes: Scope[] }>(
        `/admin/api/tenants/${tenantId}/keys`,
        { scopes },
      );
      onIssued(res);
      q.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={
        <>
          Credentials · <Mono value={tenantId} truncate={12} />
        </>
      }
    >
      <Table
        rows={q.data?.keys ?? []}
        rowKey={(k) => k.id}
        empty="No credentials issued."
        rowClass={(k) => (k.revokedAt ? "keyrow revoked" : undefined)}
        columns={[
          { header: "Key ID", cell: (k) => <Mono value={k.id} truncate={12} /> },
          { header: "Label", cell: (k) => k.label ?? "—" },
          { header: "Scopes", cell: (k) => k.scopes.join(", ") },
          { header: "Created", cell: (k) => <span className="muted">{when(k.createdAt)}</span> },
          {
            header: "Status",
            cell: (k) =>
              k.revokedAt ? <Badge tone="bad">Revoked</Badge> : <Badge tone="ok">Active</Badge>,
          },
        ]}
      />

      <div className="row" style={{ marginTop: 14, gap: 10, alignItems: "center" }}>
        <span className="muted">Issue a key with:</span>
        {ALL_SCOPES.map((s) => (
          <label key={s} className="row" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={scopes.includes(s)}
              onChange={(e) =>
                setScopes((prev) => (e.target.checked ? [...prev, s] : prev.filter((x) => x !== s)))
              }
            />
            <span className="mono">{s}</span>
          </label>
        ))}
        <button
          type="button"
          className="primary"
          disabled={busy || scopes.length === 0}
          onClick={issue}
        >
          Issue key
        </button>
      </div>
      <Hint>
        Issue the approver&rsquo;s credential as <span className="mono">approve</span> only. A key
        that can both request and approve a payout is not dual control.
      </Hint>
    </Panel>
  );
}
