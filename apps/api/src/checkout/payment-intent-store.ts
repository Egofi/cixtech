import { randomUUID } from "node:crypto";
import { FxRateEngine, type FxRateQuote } from "@cixtech/chains";
import { AppError } from "@cixtech/errors";
import type { SqlClient } from "@cixtech/ledger";

export class PaymentIntentNotFoundError extends AppError {
  readonly code = "PAYMENT_INTENT_NOT_FOUND";
}

export type PaymentIntentStatus =
  | "PENDING"
  | "PAID"
  | "EXPIRED"
  | "QUARANTINED"
  | "REFUNDED";

export interface PaymentIntent {
  id: string;
  tenantId: string;
  merchantId: string;
  amountFiat: string;
  fiatCurrency: string;
  amountCryptoBaseUnits: string;
  cryptoAsset: string;
  chain: string;
  depositAddress: string;
  quoteId: string;
  rateLockedAt: string;
  expiresAt: string;
  status: PaymentIntentStatus;
  txHash: string | null;
  offrampChannel: string | null;
  offrampAccount: string | null;
  createdAt: string;
}

export interface CreatePaymentIntentInput {
  tenantId: string;
  merchantId: string;
  amountFiat: number;
  fiatCurrency: string;
  cryptoAsset: string;
  chain: string;
  depositAddress: string;
  offrampChannel?: string;
  offrampAccount?: string;
}

export class PaymentIntentStore {
  private readonly fxEngine: FxRateEngine;

  constructor(
    private readonly sql: SqlClient,
    fxEngine?: FxRateEngine,
  ) {
    this.fxEngine = fxEngine ?? new FxRateEngine();
  }

  async create(input: CreatePaymentIntentInput): Promise<PaymentIntent> {
    const id = `pi_${randomUUID().replace(/-/g, "")}`;
    const quote = this.fxEngine.createQuote(
      input.fiatCurrency,
      input.amountFiat,
      input.cryptoAsset,
    );

    await this.sql.query(
      `INSERT INTO payment_intent (
        id, tenant_id, merchant_id, amount_fiat, fiat_currency,
        amount_crypto_base_units, crypto_asset, chain, deposit_address,
        quote_id, rate_locked_at, expires_at, status, offramp_channel, offramp_account
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDING', $13, $14)`,
      [
        id,
        input.tenantId,
        input.merchantId,
        quote.fiatAmount,
        quote.fiatCurrency,
        quote.cryptoAmountBaseUnits.toString(),
        quote.cryptoAsset,
        input.chain.toUpperCase(),
        input.depositAddress,
        quote.quoteId,
        quote.lockedAt.toISOString(),
        quote.expiresAt.toISOString(),
        input.offrampChannel ?? null,
        input.offrampAccount ?? null,
      ],
    );

    return this.getRequire(id);
  }

  async get(id: string): Promise<PaymentIntent | null> {
    const { rows } = await this.sql.query<{
      id: string;
      tenant_id: string;
      merchant_id: string;
      amount_fiat: string;
      fiat_currency: string;
      amount_crypto_base_units: string;
      crypto_asset: string;
      chain: string;
      deposit_address: string;
      quote_id: string;
      rate_locked_at: string;
      expires_at: string;
      status: string;
      tx_hash: string | null;
      offramp_channel: string | null;
      offramp_account: string | null;
      created_at: string;
    }>("SELECT * FROM payment_intent WHERE id = $1", [id]);

    const r = rows[0];
    if (!r) return null;

    // Auto-expire if PENDING and current time past expires_at
    const now = new Date();
    const expiresAt = new Date(r.expires_at);
    let status = r.status as PaymentIntentStatus;

    if (status === "PENDING" && now > expiresAt) {
      status = "EXPIRED";
      await this.sql.query(
        "UPDATE payment_intent SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING'",
        [id],
      );
    }

    return {
      id: r.id,
      tenantId: r.tenant_id,
      merchantId: r.merchant_id,
      amountFiat: r.amount_fiat,
      fiatCurrency: r.fiat_currency,
      amountCryptoBaseUnits: r.amount_crypto_base_units,
      cryptoAsset: r.crypto_asset,
      chain: r.chain,
      depositAddress: r.deposit_address,
      quoteId: r.quote_id,
      rateLockedAt: new Date(r.rate_locked_at).toISOString(),
      expiresAt: expiresAt.toISOString(),
      status,
      txHash: r.tx_hash,
      offrampChannel: r.offramp_channel,
      offrampAccount: r.offramp_account,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async getRequire(id: string): Promise<PaymentIntent> {
    const intent = await this.get(id);
    if (!intent) {
      throw new PaymentIntentNotFoundError(`Payment intent ${id} not found`, {
        context: { id },
        exposable: true,
      });
    }
    return intent;
  }

  async markPaid(id: string, txHash: string): Promise<PaymentIntent> {
    await this.sql.query(
      "UPDATE payment_intent SET status = 'PAID', tx_hash = $2 WHERE id = $1",
      [id, txHash],
    );
    return this.getRequire(id);
  }

  async listByMerchant(
    tenantId: string,
    merchantId: string,
    limit = 50,
  ): Promise<PaymentIntent[]> {
    const { rows } = await this.sql.query<{ id: string }>(
      "SELECT id FROM payment_intent WHERE tenant_id = $1 AND merchant_id = $2 ORDER BY created_at DESC LIMIT $3",
      [tenantId, merchantId, limit],
    );
    const intents: PaymentIntent[] = [];
    for (const r of rows) {
      const item = await this.get(r.id);
      if (item) intents.push(item);
    }
    return intents;
  }
}
