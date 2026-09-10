"use client";

import {
  ErrorState,
  Hint,
  Loading,
  Mono,
  PageHead,
  Panel,
  StatusBadge,
  Table,
} from "@/components/primitives";
import { ApiError, portal } from "@/lib/api";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { WebhookDelivery } from "@/types/api";
import { useState } from "react";

export default function Webhooks() {
  const q = useApi(
    () =>
      Promise.all([
        portal.get<{ url: string | null }>("/v1/webhook"),
        portal.get<{ deliveries: WebhookDelivery[] }>("/v1/webhook/deliveries?limit=100"),
      ]),
    [],
  );
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!q.data) return null;
  const [endpoint, { deliveries }] = q.data;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await portal.put<{ url: string; secret: string }>("/v1/webhook", {
        url: url.trim(),
      });
      setSecret(res.secret);
      q.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Webhooks" />

      <Panel title="Your endpoint">
        <p className="muted">
          Currently: {endpoint.url ? <Mono value={endpoint.url} /> : <em>not configured</em>}
        </p>
        {error ? <div className="banner bad">{error}</div> : null}
        <div className="row" style={{ gap: 10 }}>
          <input
            placeholder="https://your-app.example/hooks/cixtech"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="button" className="primary" disabled={busy} onClick={save}>
            Save endpoint
          </button>
        </div>
        <Hint>
          Must be a public <span className="mono">https</span> URL. Loopback, link-local and private
          addresses are refused — the engine will not be used to probe its own network.
        </Hint>
        {secret ? (
          <div className="banner warn" style={{ marginTop: 12 }}>
            <strong>Signing secret — shown once:</strong>{" "}
            <span className="mono" style={{ wordBreak: "break-all" }}>
              {secret}
            </span>
            <br />
            Verify every delivery&rsquo;s <span className="mono">x-cixtech-signature</span> against
            it.
          </div>
        ) : null}
      </Panel>

      <Panel title="Delivery history">
        <Table
          rows={deliveries}
          rowKey={(d) => d.id}
          empty="No deliveries yet."
          columns={[
            { header: "When", cell: (d) => <span className="muted">{when(d.createdAt)}</span> },
            { header: "Event", cell: (d) => <b>{d.event}</b> },
            { header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
            { header: "Attempts", numeric: true, cell: (d) => d.attempts },
            {
              header: "Last error",
              cell: (d) => <span className="muted">{d.lastError ?? "—"}</span>,
            },
          ]}
        />
      </Panel>
    </>
  );
}
