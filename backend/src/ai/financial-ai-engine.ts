import { describeAmount } from "@/chain-config";
import { kyselyFor } from "@/postgres";
import { aiActivity, aiBalances } from "@/queries";
import type { FinancialAiQueryRequest, FinancialAiQueryResponse, SqlClient } from "@/types";
import { normalTotalsByAsset } from "./balances.js";

/**
 * Every branch below answers from an exact, parameterised ledger read, so there
 * is no uncertainty in the data. What can be uncertain is whether the keyword
 * match understood the question — which is what `confidenceScore` reports.
 */
const INTENT_MATCHED = 1;
const INTENT_UNRECOGNISED = 0;

/** Per-asset totals, rendered at each asset's own scale. Assets are never summed together. */
const describeTotals = (totals: ReadonlyMap<string, bigint>): string =>
  [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([asset, amount]) => describeAmount(amount, asset))
    .join(", ");

export class FinancialAiEngine {
  constructor(
    private readonly sql: SqlClient,

    private readonly solvency?: { isSolvent(asset: string): Promise<boolean> },
  ) {}

  private assetFromPrompt(prompt: string): string {
    const m = /\b(USDT|USDC|TRX|ETH|POL|BNB|AVAX)\b/i.exec(prompt);
    return (m?.[1] ?? "USDT").toUpperCase();
  }

  async query(req: FinancialAiQueryRequest): Promise<FinancialAiQueryResponse> {
    const promptLower = req.prompt.toLowerCase();

    if (
      promptLower.includes("balance") ||
      promptLower.includes("how much") ||
      promptLower.includes("funds")
    ) {
      const rows = await aiBalances.forTenantMerchants(kyselyFor(this.sql), req.tenantId).execute();

      // Per asset, never one cross-asset sum: adding USDT base units to ETH
      // base units produces a number that means nothing in either asset.
      const totals = normalTotalsByAsset(rows);

      return {
        answer:
          totals.size === 0
            ? "Your available merchant float is zero — no balances are recorded for your accounts yet."
            : `Your available merchant float is ${describeTotals(totals)}, across ${rows.length} account balance ${rows.length === 1 ? "row" : "rows"}.`,
        intent: "BALANCE_INQUIRY",
        data: rows,
        confidenceScore: INTENT_MATCHED,
      };
    }

    if (
      promptLower.includes("fee") ||
      promptLower.includes("revenue") ||
      promptLower.includes("earning")
    ) {
      const rows = await aiBalances
        .forAccount(kyselyFor(this.sql), `egofi_fee_revenue:${req.tenantId}`)
        .execute();

      // Fee revenue accrues separately per asset, so this row set is per-asset too.
      const totals = normalTotalsByAsset(rows);

      return {
        answer:
          totals.size === 0
            ? "No platform fee revenue has accrued for your tenant yet."
            : `Accrued platform fee revenue for your tenant is ${describeTotals(totals)}.`,
        intent: "FEE_ANALYSIS",
        data: {
          feeRevenueByAsset: Object.fromEntries(
            [...totals].map(([asset, amount]) => [asset, amount.toString()]),
          ),
        },
        confidenceScore: INTENT_MATCHED,
      };
    }

    if (
      promptLower.includes("solvency") ||
      promptLower.includes("proof of reserve") ||
      promptLower.includes("float")
    ) {
      if (!this.solvency) {
        return {
          answer:
            "Solvency cannot be confirmed: this deployment has no solvency oracle configured.",
          intent: "SOLVENCY_CHECK",
          data: { isSolvent: null },
          confidenceScore: INTENT_UNRECOGNISED,
        };
      }
      const asset = this.assetFromPrompt(req.prompt);
      const isSolvent = await this.solvency.isSolvent(asset);
      return {
        answer: isSolvent
          ? `Solvency holds for ${asset}: custodied assets cover recorded liabilities.`
          : `SOLVENCY INVARIANT NOT SATISFIED for ${asset}. Payouts in this asset are refused.`,
        intent: "SOLVENCY_CHECK",
        data: { isSolvent, asset },
        confidenceScore: INTENT_MATCHED,
      };
    }

    // No keyword branch matched. Recent activity is still the most useful thing
    // to hand back, but the intent is reported as UNKNOWN rather than claiming
    // the question was understood.
    const recognised =
      promptLower.includes("transaction") ||
      promptLower.includes("history") ||
      promptLower.includes("activity") ||
      promptLower.includes("recent");

    const rows = await aiActivity
      .recentEntriesForTenant(kyselyFor(this.sql), req.tenantId, 10)
      .execute();

    const found =
      rows.length > 0
        ? `the ${rows.length} most recent journal entries touching your accounts`
        : "no journal entries recorded against your accounts yet";

    return {
      answer: recognised
        ? `Retrieved ${found}.`
        : `That question was not recognised. Returning ${found} instead.`,
      intent: recognised ? "TRANSACTION_HISTORY" : "UNKNOWN",
      data: rows,
      confidenceScore: recognised ? INTENT_MATCHED : INTENT_UNRECOGNISED,
    };
  }
}
