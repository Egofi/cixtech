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

export function accountName(key: string | null | undefined): string {
  const parts = String(key ?? "").split(":");
  const prefix = parts[0] ?? "";
  let name = ACCOUNT_NAMES[prefix];

  if (!name) {
    if (/_revenue$/.test(prefix)) name = `${titleize(prefix.replace(/_revenue$/, ""))} revenue`;
    else if (/_expense$/.test(prefix))
      name = `${titleize(prefix.replace(/_expense$/, ""))} expense`;
    else name = titleize(prefix);
  }

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

export function statusTone(status: string | null | undefined): Tone {
  const s = String(status ?? "");
  if (["settled", "delivered", "AVAILABLE", "ok"].includes(s)) return "ok";
  if (["failed", "dead", "error"].includes(s)) return "bad";
  if (["pending", "broadcasting", "broadcast", "COOLING", "IN_USE"].includes(s)) return "warn";
  return "muted";
}

export function kindTone(kind: string | null | undefined): Tone {
  const k = String(kind ?? "");
  if (k.startsWith("reverse") || k.includes("reorged")) return "bad";
  if (k.includes("quarantined")) return "warn";
  if (k.includes("finalized") || k.includes("settled") || k.includes("swept")) return "ok";
  return "muted";
}
