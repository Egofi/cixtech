"use client";

import {
  Badge,
  Banner,
  ErrorState,
  Hint,
  Loading,
  Mono,
  PageHead,
  Panel,
  Table,
} from "@/components/primitives";
import { admin } from "@/lib/api";
import { ago, when } from "@/lib/money";
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
  const [provisioned, setProvisioned] = useState<NewTenant | null>(null);
  const [creating, setCreating] = useState(false);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  return (
    <>
      <PageHead
        title="Tenants"
        actions={
          <button type="button" className="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "Create tenant"}
          </button>
        }
      />

      {creating ? (
        <CreateTenant
          onCreated={(t) => {
            setProvisioned(t);
            setCreating(false);
            q.reload();
          }}
        />
      ) : null}

      {provisioned ? (
        <TenantHandover tenant={provisioned} onDone={() => setProvisioned(null)} />
      ) : null}

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
      {selected ? <TenantUsers tenantId={selected} /> : null}
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

interface NewTenant {
  tenant: { id: string; name: string };
  apiKey: string;
  scopes: Scope[];
  owner: { email: string; role: string; password: string } | null;
}

/**
 * Provisioning asks for an owner email because a tenant needs a way for a PERSON
 * to sign in, not only a machine credential: the portal authenticates against a
 * principal, so a tenant created without one is reachable by API and by nobody
 * at the console.
 */
function CreateTenant({ onCreated }: { onCreated: (t: NewTenant) => void }) {
  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read", "move-funds"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (s: Scope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await admin.post<NewTenant>("/admin/api/tenants", {
          name: name.trim(),
          ownerEmail: ownerEmail.trim(),
          scopes,
        }),
      );
      setName("");
      setOwnerEmail("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = name.trim().length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail.trim());

  return (
    <Panel title="New tenant">
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <div className="form">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Payments"
          />
        </label>
        <label>
          Owner email
          <input
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            placeholder="ops@acme.com"
          />
        </label>
      </div>

      <Hint>
        The owner signs into the portal with this address and a one-time password shown on the next
        screen. They are a tenant <b>admin</b>, so they can move funds, approve payouts and invite
        the rest of their people. A second factor is enrolled on their first sign-in.
      </Hint>

      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <span className="muted">API key scopes:</span>
        {ALL_SCOPES.map((s) => (
          <label key={s} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
            <span className="mono">{s}</span>
          </label>
        ))}
      </div>
      <Hint>
        Scopes apply to the API key issued alongside, for the tenant's own backend.{" "}
        <code>approve</code> does not imply <code>move-funds</code> — keeping them on separate keys
        is what makes dual control mean anything.
      </Hint>

      <button type="button" className="primary" disabled={!ready || busy} onClick={submit}>
        {busy ? "Creating…" : "Create tenant"}
      </button>
    </Panel>
  );
}

/** Both credentials, shown once. Neither can be recovered afterwards. */
function TenantHandover({ tenant, onDone }: { tenant: NewTenant; onDone: () => void }) {
  return (
    <Panel title={`${tenant.tenant.name} — credentials, shown once`}>
      <Banner tone="warn">
        Neither of these is recoverable. The engine stores only a hash of each.
      </Banner>

      {tenant.owner ? (
        <>
          <p className="muted" style={{ margin: "14px 20px 4px" }}>
            <b>Portal sign-in</b>
          </p>
          <p>
            <span className="muted">Email</span> <b>{tenant.owner.email}</b>{" "}
            <Badge tone="muted">{tenant.owner.role}</Badge>
          </p>
          <p className="mono" style={{ wordBreak: "break-all" }}>
            {tenant.owner.password}
          </p>
          <Hint>Must be changed on first sign-in, which is also when TOTP is enrolled.</Hint>
        </>
      ) : (
        <Hint>No owner was named, so nobody can sign into the portal for this tenant yet.</Hint>
      )}

      <p className="muted" style={{ margin: "18px 20px 4px" }}>
        <b>API key</b>
      </p>
      <p className="mono" style={{ wordBreak: "break-all" }}>
        {tenant.apiKey}
      </p>
      <Hint>
        For the tenant's backend calling <code>/v1</code>. Scopes: {tenant.scopes.join(", ")}
      </Hint>

      <button type="button" onClick={onDone}>
        Done
      </button>
    </Panel>
  );
}

interface TenantUser {
  id: string;
  email: string;
  role: string;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  totpConfirmed: boolean;
  lastLoginAt: string | null;
}

/**
 * The tenant's people, and the controls for cutting one off.
 *
 * Separate from the API keys above because the two credentials fail differently:
 * a leaked `cxk_…` is rotated, a compromised person needs their sessions killed
 * as well — a reset alone leaves a 12h session alive.
 */
function TenantUsers({ tenantId }: { tenantId: string }) {
  const q = useApi(
    () =>
      admin.get<{ tenantId: string; users: TenantUser[] }>(`/admin/api/tenants/${tenantId}/users`),
    [tenantId],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [reset, setReset] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (userId: string, action: string) => {
    setBusy(userId);
    setError(null);
    try {
      const res = await admin.post<{ email?: string; password?: string }>(
        `/admin/api/tenants/${tenantId}/users/${userId}/${action}`,
      );
      if (action === "reset-password" && res.password && res.email) {
        setReset({ email: res.email, password: res.password });
      }
      q.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  return (
    <Panel title="People who can sign into this tenant">
      {error ? <Banner tone="bad">{error}</Banner> : null}

      {reset ? (
        <>
          <Banner tone="warn">
            New password for <b>{reset.email}</b> — shown once. Their existing sessions have been
            revoked, and they must set their own password on next sign-in.
          </Banner>
          <p className="mono" style={{ wordBreak: "break-all" }}>
            {reset.password}
          </p>
          <button type="button" onClick={() => setReset(null)}>
            Done
          </button>
        </>
      ) : null}

      <Table
        rows={q.data?.users ?? []}
        rowKey={(u) => u.id}
        empty="Nobody can sign in for this tenant yet."
        columns={[
          { header: "Email", cell: (u) => <b>{u.email}</b> },
          { header: "Role", cell: (u) => <Badge tone="muted">{u.role}</Badge> },
          {
            header: "Status",
            cell: (u) =>
              u.status === "active" ? (
                <Badge tone="ok">Active</Badge>
              ) : (
                <Badge tone="bad">Disabled</Badge>
              ),
          },
          {
            header: "2FA",
            cell: (u) =>
              u.totpConfirmed ? (
                <Badge tone="ok">Enrolled</Badge>
              ) : (
                <Badge tone="warn">Not yet</Badge>
              ),
          },
          {
            header: "Last seen",
            cell: (u) => (
              <span className="muted">{u.lastLoginAt ? ago(u.lastLoginAt) : "never"}</span>
            ),
          },
          {
            header: "",
            cell: (u) => (
              <span className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  disabled={busy === u.id}
                  onClick={() => act(u.id, "reset-password")}
                >
                  Reset password
                </button>
                <button
                  type="button"
                  disabled={busy === u.id}
                  onClick={() => act(u.id, "revoke-sessions")}
                  title="Sign them out everywhere without changing their password"
                >
                  Sign out
                </button>
                <button
                  type="button"
                  className={u.status === "active" ? "danger" : ""}
                  disabled={busy === u.id}
                  onClick={() => act(u.id, u.status === "active" ? "disable" : "enable")}
                >
                  {u.status === "active" ? "Disable" : "Enable"}
                </button>
              </span>
            ),
          },
        ]}
      />
      <Hint>
        Disabling revokes their live sessions immediately, so access stops now rather than at their
        next sign-in. Resetting a password does the same — a reset that left the old session alive
        would not have cut anyone off.
      </Hint>
    </Panel>
  );
}
