"use client";

import { SessionGate } from "@/components/session-gate";
import { type NavItem, Shell } from "@/components/shell";
import { portal } from "@/lib/api";
import { type AssetInfo, setAssets } from "@/lib/money";
import { useApi } from "@/lib/use-api";
import type { ReactNode } from "react";
import "../accent-portal.css";

const NAV: NavItem[] = [
  { href: "/portal/", label: "Overview", icon: "◉" },
  { href: "/portal/accounts/", label: "Accounts", icon: "◧" },
  { href: "/portal/deposits/", label: "Deposits", icon: "📥" },
  { href: "/portal/payouts/", label: "Payouts", icon: "📤" },
  { href: "/portal/allowlist/", label: "Allow-list", icon: "🛡" },
  { href: "/portal/webhooks/", label: "Webhooks", icon: "🔔" },
  { href: "/portal/ai/", label: "Assistant", icon: "🤖" },
];

interface ChainsResponse {
  chains: string[];
  env?: "testnet" | "mainnet";
  assets: AssetInfo[];
}

function Chrome({ signOut, children }: { signOut: () => void; children: ReactNode }) {
  // `GET /v1/chains` is the asset registry AND the first authenticated call the
  // portal makes, so a bad API key surfaces here rather than on some later page.
  const meta = useApi(() => portal.get<ChainsResponse>("/v1/chains"), []);
  if (meta.data) setAssets(meta.data.assets);

  return (
    <Shell brand="dashboard" env={meta.data?.env ?? null} nav={NAV} onSignOut={signOut}>
      {children}
    </Shell>
  );
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate kind="tenant_user" title="cixtech" prompt="Sign in with your cixtech account.">
      {(_me, signOut) => <Chrome signOut={signOut}>{children}</Chrome>}
    </SessionGate>
  );
}
