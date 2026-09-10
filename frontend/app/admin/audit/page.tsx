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
import { titleize } from "@/lib/labels";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { AuditRow } from "@/types/api";

export default function Audit() {
  const q = useApi(() => admin.get<AuditRow[]>("/admin/api/audit?limit=120"), []);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  return (
    <>
      <PageHead title="Audit trail" />
      <Panel title="Every control-plane action, including the ones that failed">
        <Table
          rows={q.data ?? []}
          rowKey={(r, i) => `${r.at}:${i}`}
          empty="No admin actions recorded."
          columns={[
            { header: "When", cell: (r) => <span className="muted">{when(r.at)}</span> },
            { header: "Actor", cell: (r) => <b>{r.actor}</b> },
            {
              header: "Action",
              cell: (r) => (
                <Badge tone={r.action.includes("killswitch") ? "bad" : "ok"}>
                  {titleize(r.action.replace(/[._]/g, " "))}
                </Badge>
              ),
            },
            { header: "Target", cell: (r) => <Mono value={r.target ?? ""} truncate={14} /> },
            {
              header: "Result",
              cell: (r) =>
                r.result === "ok" ? (
                  <Badge tone="ok">Succeeded</Badge>
                ) : (
                  <Badge tone="bad">Failed</Badge>
                ),
            },
            { header: "Detail", cell: (r) => <span className="muted">{r.detail ?? ""}</span> },
            { header: "IP", cell: (r) => <Mono value={r.ip ?? ""} /> },
          ]}
        />
        <Hint>
          This trail is append-only — the application database role has no UPDATE or DELETE on it,
          so a compromised API process cannot rewrite its own history.
        </Hint>
      </Panel>
    </>
  );
}
