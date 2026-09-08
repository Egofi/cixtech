import type { SqlClient } from "@/ledger";

export interface FinancialAiQueryRequest {
  tenantId: string;
  prompt: string;
}

export interface FinancialAiQueryResponse {
  answer: string;
  intent: "BALANCE_INQUIRY" | "TRANSACTION_HISTORY" | "FEE_ANALYSIS" | "SOLVENCY_CHECK" | "UNKNOWN";
  data?: unknown;
  confidenceScore: number;
}

/**
 * Autonomous Natural Language Financial Query Engine (US-AI-01, PRD §4.4.1).
 *
 * Converts natural language queries into structured double-entry sub-ledger queries
 * and generates human-readable financial insights.
 */
export class FinancialAiEngine {
  constructor(
    private readonly sql: SqlClient,
    /** Answers the solvency question from the ledger. Absent = the engine says so. */
    private readonly solvency?: { isSolvent(asset: string): Promise<boolean> },
  ) {}

  /** Pull an asset symbol out of the prompt, defaulting to USDT. */
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
      // Anchored to the merchant-liability prefix rather than a bare substring
      // match: '%tenant%' also caught fee-revenue and suspense accounts, so the
      // "available float" it reported was not the float.
      const { rows } = await this.sql.query<{ account: string; asset: string; amount: string }>(
        `SELECT account, asset, amount FROM balance
          WHERE account LIKE 'merchant_available:' || $1 || ':%'`,
        [req.tenantId],
      );

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
      const { rows } = await this.sql.query<{ account: string; asset: string; amount: string }>(
        "SELECT account, asset, amount FROM balance WHERE account = $1",
        [`egofi_fee_revenue:${req.tenantId}`],
      );

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
      // Previously hardcoded `isSolvent: true` regardless of the ledger, which is
      // the single worst thing this endpoint could say. Ask the ledger instead —
      // and when no oracle is wired, say we cannot answer rather than assert.
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

    // Default: recent activity for THIS tenant.
    //
    // Two bugs lived here. The column was `created_at`, which journal_entry does
    // not have (it is `occurred_at`) — so this branch threw a 500 on every prompt
    // that missed the keywords above, and had evidently never run. And the query
    // carried no tenant predicate at all while the answer told the caller these
    // were entries "for your tenant": correcting only the column name would have
    // turned a dead branch into a cross-tenant disclosure.
    //
    // The predicate joins through `posting`, because journal_entry itself carries
    // no tenant column — the tenant is encoded in the ledger account keys the
    // entry touches, which is the same shape PortalService.deposits() uses.
    const { rows } = await this.sql.query<{ id: string; kind: string; occurred_at: string }>(
      `SELECT je.id, je.kind, je.occurred_at
         FROM journal_entry je
        WHERE EXISTS (
          SELECT 1 FROM posting p
           WHERE p.journal_entry_id = je.id
             AND (p.account LIKE 'merchant_available:' || $1 || ':%'
               OR p.account LIKE 'merchant_pending_withdrawal:' || $1 || ':%'
               OR p.account LIKE 'compliance_suspense:' || $1 || '%'
               OR p.account LIKE 'egofi_fee_revenue:' || $1 || '%')
        )
        ORDER BY je.occurred_at DESC
        LIMIT 10`,
      [req.tenantId],
    );

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
