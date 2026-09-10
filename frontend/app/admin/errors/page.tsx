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

interface ErrorRow {
  id: string;
  code: string;
  message: string;
  at: string;
}

export default function Errors() {
  const q = useApi(() => admin.get<ErrorRow[]>("/admin/api/errors?limit=120"), []);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  return (
    <>
      <PageHead title="Errors" />
      <Panel title="Recorded faults">
        <Table
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          empty="No errors recorded."
          columns={[
            { header: "When", cell: (r) => <span className="muted">{when(r.at)}</span> },
            { header: "Code", cell: (r) => <Badge tone="bad">{r.code}</Badge> },
            { header: "Message", cell: (r) => r.message },
            { header: "Correlation ID", cell: (r) => <Mono value={r.id} truncate={14} /> },
          ]}
        />
        <Hint>
          Authentication and validation failures are counted in metrics rather than stored here — an
          unauthenticated caller must not be able to grow an append-only table without bound.
        </Hint>
      </Panel>
    </>
  );
}
