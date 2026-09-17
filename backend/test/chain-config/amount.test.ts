import { decimalsFor, describeAmount, formatBaseUnits, totalsByAsset } from "@/chain-config";
import { describe, expect, it } from "vitest";

describe("formatBaseUnits scales by the asset's own decimals", () => {
  it("scales a 6-decimal asset", () => {
    expect(formatBaseUnits(1_500_000n, "USDT")).toBe("1.5");
    expect(formatBaseUnits(1_000_000n, "USDT")).toBe("1");
    expect(formatBaseUnits(1n, "USDT")).toBe("0.000001");
    expect(formatBaseUnits(0n, "USDT")).toBe("0");
  });

  it("scales an 18-decimal asset by eighteen, not six", () => {
    // The defect this pins: `Number(x) / 1e6` reported 1 ETH as 1,000,000,000,000.
    expect(decimalsFor("ETH")).toBe(18);
    expect(formatBaseUnits(10n ** 18n, "ETH")).toBe("1");
    expect(formatBaseUnits(10n ** 18n / 2n, "ETH")).toBe("0.5");
  });

  it("stays exact past 2^53, where a float silently rounds", () => {
    const huge = 123_456_789_012_345_678_901n; // > Number.MAX_SAFE_INTEGER
    expect(formatBaseUnits(huge, "USDT")).toBe("123456789012345.678901");

    // What the old `Number(x) / 1e6` produced: the last digits are simply gone.
    // Asserted as a string because the correct value has no float representation
    // to compare against — which is the point.
    expect(String(Number(huge) / 1e6)).not.toBe("123456789012345.678901");
  });

  it("handles negatives without losing the sign or a digit", () => {
    expect(formatBaseUnits(-1_500_000n, "USDT")).toBe("-1.5");
    expect(formatBaseUnits(-1n, "USDT")).toBe("-0.000001");
  });

  it("returns null for an asset with no known scale rather than assuming one", () => {
    expect(decimalsFor("NOPE")).toBeNull();
    expect(formatBaseUnits(1_000_000n, "NOPE")).toBeNull();
  });
});

describe("describeAmount says whether the number is scaled", () => {
  it("renders a known asset at its own scale", () => {
    expect(describeAmount(2_500_000n, "USDT")).toBe("2.5 USDT");
  });

  it("labels an unknown asset as base units, never as a scaled amount", () => {
    expect(describeAmount(2_500_000n, "NOPE")).toBe("2500000 NOPE base units");
  });
});

describe("totalsByAsset never adds one asset to another", () => {
  it("keeps each asset's base units separate", () => {
    const totals = totalsByAsset([
      { asset: "USDT", amount: "1000000" },
      { asset: "ETH", amount: "1000000000000000000" },
      { asset: "USDT", amount: "500000" },
    ]);

    expect(totals.get("USDT")).toBe(1_500_000n);
    expect(totals.get("ETH")).toBe(10n ** 18n);
    // The old cross-asset sum would have been this meaningless figure:
    expect([...totals.values()].length).toBe(2);
  });

  it("normalises the asset symbol's case", () => {
    const totals = totalsByAsset([
      { asset: "usdt", amount: "1" },
      { asset: "USDT", amount: "2" },
    ]);
    expect(totals.get("USDT")).toBe(3n);
  });

  it("is empty for no rows", () => {
    expect(totalsByAsset([]).size).toBe(0);
  });
});
