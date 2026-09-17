import { normalTotalsByAsset } from "@/ai/balances.js";
import { describe, expect, it } from "vitest";

/**
 * `balance.amount` is a signed net with DEBIT positive. A liability account is
 * therefore stored NEGATIVE when it holds value, which is why anything reporting
 * a balance to a human has to convert it first.
 */
describe("normalTotalsByAsset reports each account in its normal direction", () => {
  it("reports a merchant's available liability as a positive balance", () => {
    const totals = normalTotalsByAsset([
      // 1.5 USDT credited to the merchant: stored as -1_500_000.
      { account: "merchant_available:t1:m1", asset: "USDT", amount: "-1500000" },
    ]);
    expect(totals.get("USDT")).toBe(1_500_000n);
  });

  it("reports accrued revenue as positive too", () => {
    const totals = normalTotalsByAsset([
      { account: "egofi_fee_revenue:t1", asset: "USDT", amount: "-5000" },
    ]);
    expect(totals.get("USDT")).toBe(5_000n);
  });

  it("leaves an asset account's debit balance positive", () => {
    const totals = normalTotalsByAsset([
      { account: "pool_addr:TRON:m1", asset: "USDT", amount: "1000000" },
    ]);
    expect(totals.get("USDT")).toBe(1_000_000n);
  });

  it("keeps assets apart while summing accounts within one asset", () => {
    const totals = normalTotalsByAsset([
      { account: "merchant_available:t1:m1", asset: "USDT", amount: "-1000000" },
      { account: "merchant_available:t1:m2", asset: "USDT", amount: "-500000" },
      { account: "merchant_available:t1:m1", asset: "ETH", amount: "-1000000000000000000" },
    ]);

    expect(totals.get("USDT")).toBe(1_500_000n);
    expect(totals.get("ETH")).toBe(10n ** 18n);
    expect(totals.size).toBe(2);
  });

  it("is empty for no rows", () => {
    expect(normalTotalsByAsset([]).size).toBe(0);
  });
});
