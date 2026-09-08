"use client";

import { SessionGate } from "@/components/session-gate";
import { type NavItem, Shell } from "@/components/shell";
import { admin } from "@/lib/api";
import { type AssetInfo, setAssets } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { ReactNode } from "react";
import "../accent-admin.css";

const NAV: NavItem[] = [
  { href: "/admin/", label: "Overview", icon: "◉" },
  { href: "/admin/tenants/", label: "Tenants", icon: "◧" },
  { href: "/admin/pools/", label: "Pool addresses", icon: "👛" },
  { href: "/admin/ledger/", label: "Ledger", icon: "≡" },
  { href: "/admin/deposits/", label: "Deposits", icon: "📥" },
  { href: "/admin/payouts/", label: "Payouts", icon: "📤" },
  { href: "/admin/earnings/", label: "Earnings", icon: "💵" },
  { href: "/admin/webhooks/", label: "Webhooks", icon: "🔔" },
  { href: "/admin/audit/", label: "Audit trail", icon: "🛡" },
  { href: "/admin/errors/", label: "Errors", icon: "⚠" },
];

/**
 * Loads the asset registry once for the whole console.
 *
 * Every money figure on every page needs decimals, and they come from the API
 * rather than a table in this codebase. Fetching it here means a page cannot
 * render a balance before the decimals that make it meaningful have arrived.
 */
function Chrome({ signOut, children }: { signOut: () => void; children: ReactNode }) {
  const meta = useApi(
    () => admin.get<{ assets: AssetInfo[]; env: string | null }>("/admin/api/assets"),
    [],
  );
  if (meta.data) setAssets(meta.data.assets);

  return (
    <Shell brand="admin" env={meta.data?.env ?? null} nav={NAV} onSignOut={signOut}>
      {children}
    </Shell>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate kind="operator" title="cixtech admin" prompt="Sign in with your operator account.">
      {(_me, signOut) => <Chrome signOut={signOut}>{children}</Chrome>}
    </SessionGate>
  );
}
