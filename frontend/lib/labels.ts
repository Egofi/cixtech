/**
 * Plain language for the engine's internal identifiers.
 *
 * Ledger account keys and entry kinds are machine identifiers —
 * `merchant_available:<tenant>:<account>`, `deposit.finalized`. A non-technical
 * operator reading a console needs "Merchant balance" and "Deposit received",
 * with the raw key still available underneath (on hover, or in a monospace
 * column) so an engineer can still grep for it.
 *
 * These maps are product copy carried over verbatim from the previous consoles.
 * Changing a string here changes what an operator sees during an incident, so
 * treat them as text, not as constants to tidy.
 */

const ACCOUNT_NAMES: Record<string, string> = {
  merchant_available: "Merchant balance",
  merchant_pending: "Merchant pending",
  compliance_suspense: "Compliance hold",
  pool_addr: "Deposit wallet",
  pool_addr_unconfirmed: "Deposit wallet (unconfirmed)",
  treasury: "Treasury",
  cold: "Cold storage",
  gas_float: "Gas float",
};

const KIND_LABELS: Record<string, string> = {
  "deposit.detected": "Deposit seen on-chain",
  "deposit.confirmed": "Deposit confirming",
  "deposit.finalized": "Deposit received",
  "deposit.quarantined": "Deposit held for review",
  "deposit.released": "Deposit released from hold",
  "deposit.reorged": "Deposit reversed (chain reorg)",
  "payout.locked": "Payout funds locked",
  "payout.settled": "Payout sent",
  "fee.swept": "Fees swept",
  reverse: "Correcting reversal",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  broadcasting: "Sending",
  broadcast: "Sent",
  settled: "Confirmed",
  failed: "Failed",
  delivered: "Delivered",
  dead: "Given up",
  AVAILABLE: "Ready to use",
  IN_USE: "In use",
  COOLING: "Cooling down",
};

export function titleize(s: string): string {
  const v = String(s ?? "")
    .replace(/[._]/g, " ")
    .trim();
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
}

/** A ledger account key as something a person reads. */
export function accountName(key: string | null | undefined): string {
  const parts = String(key ?? "").split(":");
  const prefix = parts[0] ?? "";
  let name = ACCOUNT_NAMES[prefix];

  if (!name) {
    // The prefix often already names the fee ("egofi_fee_revenue"), so append only
    // the suffix rather than re-stating it.
    if (/_revenue$/.test(prefix)) name = `${titleize(prefix.replace(/_revenue$/, ""))} revenue`;
    else if (/_expense$/.test(prefix))
      name = `${titleize(prefix.replace(/_expense$/, ""))} expense`;
    else name = titleize(prefix);
  }
  // pool_addr keys carry the chain in slot 1; it is the useful half of the tail.
  if (prefix.startsWith("pool_addr") && parts[1]) name += ` · ${parts[1]}`;
  return name;
}

export function kindLabel(kind: string | null | undefined): string {
  const k = String(kind ?? "");
  if (KIND_LABELS[k]) return KIND_LABELS[k] as string;
  if (k.startsWith("reverse")) return "Correcting reversal";
  return titleize(k.replace(/\./g, " "));
}

export function statusLabel(status: string | null | undefined): string {
  const k = String(status ?? "");
  return STATUS_LABELS[k] ?? titleize(k);
}

export type Tone = "ok" | "bad" | "warn" | "muted";

/** The tone a status should be shown in — green, red, amber, or quiet. */
export function statusTone(status: string | null | undefined): Tone {
  const s = String(status ?? "");
  if (["settled", "delivered", "AVAILABLE", "ok"].includes(s)) return "ok";
  if (["failed", "dead", "error"].includes(s)) return "bad";
  if (["pending", "broadcasting", "broadcast", "COOLING", "IN_USE"].includes(s)) return "warn";
  return "muted";
}

/** The tone an entry kind should be shown in. */
export function kindTone(kind: string | null | undefined): Tone {
  const k = String(kind ?? "");
  if (k.startsWith("reverse") || k.includes("reorged")) return "bad";
  if (k.includes("quarantined")) return "warn";
  if (k.includes("finalized") || k.includes("settled") || k.includes("swept")) return "ok";
  return "muted";
}
