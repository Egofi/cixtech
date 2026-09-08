"use client";

import {
  ErrorState,
  Loading,
  Mono,
  PageHead,
  Panel,
  StatusBadge,
  Table,
} from "@/components/primitives";
import { admin } from "@/lib/api";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import { useState } from "react";

interface Delivery {
  id: string;
  tenant_id: string;
  status: string;
  attempts: number;
  next_attempt: string;
  last_error: string | null;
}

export default function Webhooks() {
  const q = useApi(() => admin.get<Delivery[]>("/admin/api/webhooks?limit=100"), []);
  const [busy, setBusy] = useState<string | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  async function act(id: string, action: "replay" | "cancel") {
    setBusy(id);
    try {
      await admin.post(`/admin/api/webhooks/${id}/${action}`);
      q.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHead title="Webhook deliveries" />
      <Panel title="Outbox">
        <Table
          rows={q.data ?? []}
          rowKey={(d) => d.id}
          empty="No deliveries queued."
          columns={[
            { header: "Delivery", cell: (d) => <Mono value={d.id} truncate={14} /> },
            { header: "Tenant", cell: (d) => <Mono value={d.tenant_id} truncate={12} /> },
            { header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
            { header: "Attempts", numeric: true, cell: (d) => d.attempts },
            {
              header: "Next attempt",
              cell: (d) => <span className="muted">{when(d.next_attempt)}</span>,
            },
            {
              header: "Last error",
              cell: (d) => <span className="muted">{d.last_error ?? "—"}</span>,
            },
            {
              header: "",
              cell: (d) => (
                <span className="actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy === d.id}
                    onClick={() => act(d.id, "replay")}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy === d.id}
                    onClick={() => act(d.id, "cancel")}
                  >
                    Give up
                  </button>
                </span>
              ),
            },
          ]}
        />
      </Panel>
    </>
  );
}
