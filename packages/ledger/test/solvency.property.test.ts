import { describe, it } from "vitest";

describe("solvency invariant", () => {
  // Property 7 — Σ ASSET ≥ Σ LIABILITY holds at every step of any valid history.
  it.todo("[7] solvency holds across any generated deposit/finalize/payout/fee/reversal history");

  // Property 8 — a payout exceeding merchant_available is rejected; no negative liability.
  it.todo("[8] over-withdrawal is rejected; no negative available balance is reachable");

  // Property 9 — ADR 0009 identity: pool_addr == merchant_available + accrued unswept fee.
  it.todo("[9] pool_addr balance == merchant_available + accrued-unswept egofi_fee_revenue");
});
