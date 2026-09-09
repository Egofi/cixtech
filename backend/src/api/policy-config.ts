import { chainEnvOrNull } from "@/chain-config";
import type { PolicyConfigReport } from "@/types";

const REQUIRED: ReadonlyArray<{ vars: readonly string[]; control: string; consequence: string }> = [
  {
    vars: ["CIXTECH_POLICY_KEY"],
    control: "payout authorization token (§7)",
    consequence:
      "payouts broadcast with no authorization binding, so nothing re-verifies the transfer at the signing boundary",
  },
  {
    vars: ["CIXTECH_APPROVAL_THRESHOLD", "CIXTECH_APPROVAL_REQUIRED"],
    control: "dual approval / separation of duties (§7.4)",
    consequence: "no payout ever requires a second credential, at any amount",
  },
  {
    vars: ["CIXTECH_TIMELOCK_THRESHOLD", "CIXTECH_TIMELOCK_DELAY_MS"],
    control: "high-value time-lock (§7.5)",
    consequence: "large payouts sign immediately, with no cancel window",
  },
  {
    vars: ["CIXTECH_MAX_PAYOUT"],
    control: "per-payout ceiling (§7)",
    consequence: "a single payout is bounded only by the merchant's balance",
  },
  {
    vars: ["CIXTECH_VELOCITY_MAX", "CIXTECH_VELOCITY_WINDOW_MS"],
    control: "rolling velocity cap (§7.3)",
    consequence:
      "a compromised credential can drain in many small payouts instead of one large one",
  },
];

export function assertCustodyModelAcknowledged(
  env: Record<string, string | undefined> = process.env,
): { model: "hot-key"; acknowledged: boolean } {
  const acknowledged = env["CIXTECH_ACKNOWLEDGE_HOT_KEY"] === "true";
  if (chainEnvOrNull() === "mainnet" && !acknowledged) {
    throw new Error(
      [
        "Refusing to start mainnet custody with the signing key held in this process.",
        "",
        "  CIXTECH_ENGINE_XPRV is loaded into the API process, which also terminates",
        "  public HTTP. Threshold MPC (packages/mpc) is NOT wired into this path, so",
        "  there is one hot key and no second gate on it.",
        "",
        "  Move the key behind a KMS/HSM or the MPC signing domain, or — if running",
        "  a hot key is the deliberate launch posture — set:",
        "",
        "      CIXTECH_ACKNOWLEDGE_HOT_KEY=true",
        "",
        "  See ADR 0007 and docs/SECURITY_AUDIT.md (CX-16).",
      ].join("\n"),
    );
  }
  return { model: "hot-key", acknowledged };
}

export function assertPolicyConfigured(
  env: Record<string, string | undefined> = process.env,
): PolicyConfigReport {
  const enforced = chainEnvOrNull() === "mainnet";
  const gaps: string[] = [];
  const missing: string[] = [];

  for (const { vars, control, consequence } of REQUIRED) {
    const absent = vars.filter((v) => !env[v]);
    if (absent.length === 0) continue;
    missing.push(control);
    gaps.push(
      `  • ${control}\n      unset: ${absent.join(", ")}\n      without it: ${consequence}`,
    );
  }

  if (enforced && gaps.length > 0) {
    throw new Error(
      [
        "Refusing to start on mainnet with money-out guardrails unconfigured.",
        "",
        ...gaps,
        "",
        "Set these in the environment, or run with CHAIN_ENV=testnet if this deployment",
        "genuinely holds no value. A custody engine must not start with a control",
        "silently absent — see build spec §7 and docs/SECURITY_AUDIT.md (CX-04).",
      ].join("\n"),
    );
  }
  return { enforced, missing };
}
