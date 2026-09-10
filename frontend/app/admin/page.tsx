"use client";

import {
  Banner,
  ErrorState,
  Loading,
  Money,
  PageHead,
  Panel,
  StatGrid,
  Table,
} from "@/components/primitives";
import { Badge, Hint } from "@/components/primitives";
import { admin } from "@/lib/api";
import { kindLabel } from "@/lib/labels";
import { type AssetInfo, humanMs, money } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import { useState } from "react";

interface Solvency {
  asset: string;
  assets: string;
  liabilities: string;
  solvent: boolean;
}
interface Overview {
  counts: { entries?: number; tenants?: number; accounts?: number };
  solvency: Solvency[];
  killSwitchEngaged: boolean;
  limits: { maxPerPayout: string; velocityWindowMs: number; velocityMax: string };
  assets: AssetInfo[];
}
interface DepositRow {
  kind: string;
}
interface PayoutRow {
  status: string;
}

export default function AdminOverview() {
  const [busy, setBusy] = useState(false);
  const q = useApi(
    () =>
      Promise.all([
        admin.get<Overview>("/admin/api/overview"),
        admin.get<DepositRow[]>("/admin/api/deposits?limit=100"),
        admin.get<PayoutRow[]>("/admin/api/payouts?limit=100"),
      ]),
    [],
  );

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!q.data) return null;

  const [d, deposits, payouts] = q.data;
  const limitAsset = d.solvency[0]?.asset ?? "";

  async function toggleKillSwitch() {
    setBusy(true);
    try {
      await admin.post(
        d.killSwitchEngaged ? "/admin/api/killswitch/reset" : "/admin/api/killswitch/engage",
      );
      q.reload();
    } finally {
      setBusy(false);
    }
  }

  const held =
    d.solvency.map((s) => `${money(s.assets, s.asset)} ${s.asset}`).join(" + ") || "0.00";

  return (
    <>
      <PageHead
        title="Overview"
        actions={
          <button
            type="button"
            className={d.killSwitchEngaged ? "primary" : "danger"}
            disabled={busy}
            onClick={toggleKillSwitch}
          >
            {d.killSwitchEngaged ? "Release kill-switch" : "Engage kill-switch"}
          </button>
        }
      />

      {d.killSwitchEngaged ? (
        <Banner tone="bad">Kill-switch ENGAGED — all payouts are halted.</Banner>
      ) : (
        <Banner tone="ok">Kill-switch clear — payouts flowing normally.</Banner>
      )}

      <StatGrid
        cards={[
          {
            title: "LEDGER MOVEMENTS",
            value: (d.counts.entries ?? deposits.length + payouts.length).toLocaleString(),
            sub: "Journal entries recorded",
            icon: "≡",
          },
          { title: "HELD FOR CUSTOMERS", value: held, sub: "Across every asset", icon: "🏦" },
          {
            title: "DEPOSITS",
            value: deposits.length.toLocaleString(),
            sub: `${deposits.filter((x) => x.kind === "deposit.finalized").length} credited`,
            icon: "📥",
          },
          {
            title: "PAYOUTS",
            value: payouts.length.toLocaleString(),
            sub: `${payouts.filter((x) => x.status === "settled").length} confirmed`,
            icon: "📤",
          },
        ]}
      />

      <Panel title="Solvency">
        <Table
          rows={d.solvency}
          rowKey={(r) => r.asset}
          columns={[
            { header: "Asset", cell: (r) => <b>{r.asset}</b> },
            {
              header: "Held for customers",
              numeric: true,
              cell: (r) => <Money base={r.assets} asset={r.asset} />,
            },
            {
              header: "Owed to customers",
              numeric: true,
              cell: (r) => <Money base={r.liabilities} asset={r.asset} />,
            },
            {
              header: "Status",
              cell: (r) =>
                r.solvent ? (
                  <Badge tone="ok">Fully backed</Badge>
                ) : (
                  <Badge tone="bad">SHORTFALL</Badge>
                ),
            },
          ]}
        />
        <Hint>
          Every asset must hold at least what it owes. A shortfall means customer balances exceed
          the funds on chain.
        </Hint>
      </Panel>

      <Panel title="Money-out limits">
        <div className="tablewrap">
          <table>
            <tbody>
              <tr>
                <td>Most that can leave in one payout</td>
                <td className="num">
                  <Money base={d.limits.maxPerPayout} asset={limitAsset} />
                </td>
              </tr>
              <tr>
                <td>Rolling window</td>
                <td className="num">{humanMs(d.limits.velocityWindowMs)}</td>
              </tr>
              <tr>
                <td>Most that can leave within that window</td>
                <td className="num">
                  <Money base={d.limits.velocityMax} asset={limitAsset} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Recent activity">
        <Table
          rows={deposits.slice(0, 10)}
          rowKey={(_, i) => String(i)}
          empty="No deposits yet."
          columns={[{ header: "Event", cell: (r) => kindLabel(r.kind) }]}
        />
      </Panel>
    </>
  );
}
