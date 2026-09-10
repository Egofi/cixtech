"use client";

import { Badge, ErrorState, Hint, Loading, PageHead, Panel, Table } from "@/components/primitives";
import { ApiError, portal } from "@/lib/api";
import { when } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import { useState } from "react";

interface QueryResponse {
  answer: string;
  intent: string;
  data?: unknown;
  confidenceScore: number;
}
interface Anomaly {
  id: string;
  type: string;
  severity: string;
  description: string;
  detectedAt: string;
}

export default function Assistant() {
  const anomalies = useApi(() => portal.get<{ anomalies: Anomaly[] }>("/v1/ai/anomalies"), []);
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<QueryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await portal.post<{ response: QueryResponse }>("/v1/ai/query", {
        prompt: prompt.trim(),
      });
      setAnswer(res.response);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Assistant" />

      <Panel title="Ask about your ledger">
        <div className="row" style={{ gap: 10 }}>
          <input
            placeholder="What is our available USDT balance?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          <button type="button" className="primary" disabled={busy} onClick={ask}>
            {busy ? "Asking…" : "Ask"}
          </button>
        </div>
        {error ? <div className="banner bad">{error}</div> : null}
        {answer ? (
          <div className="panel" style={{ margin: "14px 0 0" }}>
            <h3>
              🤖 Assistant
              <Badge tone="muted">{Math.round(answer.confidenceScore * 100)}% confidence</Badge>
            </h3>
            <p style={{ padding: "16px 20px", margin: 0 }}>{answer.answer}</p>
          </div>
        ) : null}
        <Hint>
          Answers are computed from your own ledger rows only. Solvency is read from the ledger, not
          asserted.
        </Hint>
      </Panel>

      <Panel title="Risk anomalies">
        {anomalies.loading ? (
          <Loading />
        ) : anomalies.error ? (
          <ErrorState error={anomalies.error} retry={anomalies.reload} />
        ) : (
          <Table
            rows={anomalies.data?.anomalies ?? []}
            rowKey={(a) => a.id}
            empty="No anomalies detected."
            columns={[
              {
                header: "Detected",
                cell: (a) => <span className="muted">{when(a.detectedAt)}</span>,
              },
              { header: "Type", cell: (a) => <Badge tone="warn">{a.type}</Badge> },
              {
                header: "Severity",
                cell: (a) => (
                  <Badge tone={a.severity === "CRITICAL" || a.severity === "HIGH" ? "bad" : "warn"}>
                    {a.severity}
                  </Badge>
                ),
              },
              { header: "What happened", cell: (a) => a.description },
            ]}
          />
        )}
      </Panel>
    </>
  );
}
