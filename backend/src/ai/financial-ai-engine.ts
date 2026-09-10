import { kyselyFor } from "@/postgres";
import { aiActivity, aiBalances } from "@/queries";
import type { FinancialAiQueryRequest, FinancialAiQueryResponse, SqlClient } from "@/types";

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

      const totalBalance = rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
      const formattedTotal = (Number(totalBalance) / 1e6).toFixed(2);

      return {
        answer: `Your total available merchant float across all accounts is ${formattedTotal} base units. Found ${rows.length} active account balance rows.`,
        intent: "BALANCE_INQUIRY",
        data: rows,
        confidenceScore: 0.96,
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

      const feeAmt = rows[0]?.amount ?? "0";
      const formattedFee = (Number(BigInt(feeAmt)) / 1e6).toFixed(2);

      return {
        answer: `Accrued platform fee revenue for your tenant is ${formattedFee} (${feeAmt} base units).`,
        intent: "FEE_ANALYSIS",
        data: { feeRevenueBaseUnits: feeAmt },
        confidenceScore: 0.98,
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
          confidenceScore: 0,
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
        confidenceScore: 0.99,
      };
    }

    const rows = await aiActivity
      .recentEntriesForTenant(kyselyFor(this.sql), req.tenantId, 10)
      .execute();

    return {
      answer:
        rows.length > 0
          ? `Retrieved the ${rows.length} most recent journal entries touching your accounts.`
          : "No journal entries have been recorded against your accounts yet.",
      intent: "TRANSACTION_HISTORY",
      data: rows,
      confidenceScore: 0.85,
    };
  }
}
