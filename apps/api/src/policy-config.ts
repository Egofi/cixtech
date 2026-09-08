import { chainEnvOrNull } from "@cixtech/chain-config";

/**
 * Refuse to boot a value-bearing deployment with its money-out guardrails
 * switched off (build spec §7).
 *
 * Every control in `server.ts` used to be composed from an OPTIONAL environment
 * variable, and an absent one removed the control rather than stopping the boot.
 * That is the wrong default for a custody engine: the failure is silent, it looks
 * exactly like a healthy start-up, and the first evidence of it is a payout that
 * should have been held going straight out. A missing guardrail must be as loud
 * as a missing RPC URL.
 *
 * The rule is deliberately narrow. On testnet, and in the test harness, a partial
 * configuration is legitimate — those deployments hold no value and the tests
 * need to exercise a policy engine one control at a time. On mainnet every
 * control below is required, and the process exits before it ever listens.
 *
 * `resolveTokenContracts` in @cixtech/chains is the model: it refuses to register
 * a chain whose tokens it cannot price, because a silent zero is worse than a
 * failure. This is the same argument applied to policy.
 */

/** One required setting, and what its absence would actually mean at runtime. */
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

/**
 * Refuse to run mainnet custody on a hot key held in this process, unless an
 * operator has explicitly said that is the intent.
 *
 * `packages/mpc` implements threshold signing but is not on the production path:
 * `buildRouter` constructs a `KeypairSigner` from `CIXTECH_ENGINE_XPRV`, so the
 * deployed model is one HD key in the memory of the process that terminates public
 * HTTP. Any code-execution bug, memory disclosure or `/proc/self/environ` read is
 * a total loss of custody.
 *
 * That is a legitimate launch posture — ADR 0007 says so — but it must be a
 * decision somebody made, not a default nobody noticed. The acknowledgement is
 * the whole control: it puts the choice in the deployment record, and it stops
 * mainnet custody from starting on a hot key by accident.
 */
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

export interface PolicyConfigReport {
  /** True when this deployment is required to have every control configured. */
  enforced: boolean;
  /** Controls that are NOT configured — empty on a correctly configured mainnet. */
  missing: string[];
}

/**
 * Check the money-out configuration. Throws on mainnet when anything is missing;
 * on testnet returns what is absent so the caller can log it loudly instead.
 */
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
