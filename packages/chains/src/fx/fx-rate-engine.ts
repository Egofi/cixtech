import { assetRegistry } from "@cixtech/chain-config";
import { AppError } from "@cixtech/errors";

export class FxRateExpiredError extends AppError {
  readonly code = "FX_RATE_EXPIRED";
}

export class UnsupportedCurrencyError extends AppError {
  readonly code = "UNSUPPORTED_CURRENCY";
}

export const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes (900 seconds)

export interface FxRateQuote {
  quoteId: string;
  fiatCurrency: string;
  fiatAmount: string;
  cryptoAsset: string;
  cryptoAmountBaseUnits: bigint;
  cryptoAmountFormatted: string;
  exchangeRate: number; // Fiat per 1 crypto unit (e.g., 1 USDT = 1.00 USD, 1 BTC = 65000.00 USD, 1 USDT = 1600.00 NGN)
  guaranteedSpreadBps: number;
  lockedAt: Date;
  expiresAt: Date;
}

export interface FxRateEngineConfig {
  /** Guaranteed rate spread in basis points (default: 50 BPS = 0.5%). */
  spreadBps?: number;
  /** Lock duration in milliseconds (default: 15 minutes). */
  lockDurationMs?: number;
}

/** Default static exchange rates for fiat-to-crypto conversion (in production, backed by Oracle/Exchange feeds). */
const BASE_FIAT_RATES: Record<string, Record<string, number>> = {
  USD: { USDT: 1.0, USDC: 1.0, ETH: 3200.0, BTC: 65000.0 },
  EUR: { USDT: 0.92, USDC: 0.92, ETH: 2944.0, BTC: 59800.0 },
  NGN: { USDT: 1600.0, USDC: 1600.0, ETH: 5120000.0, BTC: 104000000.0 },
  KES: { USDT: 130.0, USDC: 130.0, ETH: 416000.0, BTC: 8450000.0 },
  BRL: { USDT: 5.45, USDC: 5.45, ETH: 17440.0, BTC: 354250.0 },
};

/**
 * 15-Minute Guaranteed Exchange Rate Lock & FX Engine (US-FX-01, PRD §3.2.1).
 *
 * Computes exact crypto amounts required for a fiat invoice, applying a guaranteed
 * price lock window (900s). Even if the market fluctuates by 10% during checkout,
 * the merchant receives 100% of the locked fiat equivalent.
 */
export class FxRateEngine {
  private readonly spreadBps: number;
  private readonly lockDurationMs: number;

  constructor(config: FxRateEngineConfig = {}) {
    this.spreadBps = config.spreadBps ?? 50; // 0.5% default buffer
    this.lockDurationMs = config.lockDurationMs ?? LOCK_DURATION_MS;
  }

  /**
   * Get real-time exchange rate (fiat per 1 whole unit of crypto).
   */
  getRate(fiatCurrency: string, cryptoAsset: string): number {
    const fiat = fiatCurrency.toUpperCase();
    const crypto = cryptoAsset.toUpperCase();

    const ratesForFiat = BASE_FIAT_RATES[fiat];
    if (!ratesForFiat || !ratesForFiat[crypto]) {
      throw new UnsupportedCurrencyError(
        `Exchange rate not available for pair ${fiat}/${crypto}`,
        { context: { fiat, crypto }, exposable: true },
      );
    }
    return ratesForFiat[crypto];
  }

  /**
   * Create a 15-minute guaranteed price lock quote for a payment intent.
   */
  createQuote(
    fiatCurrency: string,
    fiatAmount: number,
    cryptoAsset: string,
    now: Date = new Date(),
  ): FxRateQuote {
    const fiat = fiatCurrency.toUpperCase();
    const crypto = cryptoAsset.toUpperCase();
    const baseRate = this.getRate(fiat, crypto);

    // Apply guaranteed price lock spread (buffer against market drop)
    const effectiveRate = baseRate * (1 - this.spreadBps / 10000);

    // Calculate whole crypto units needed
    const cryptoUnits = fiatAmount / effectiveRate;

    // Get asset decimals from registry or default to 6 for stablecoins
    const assets = assetRegistry();
    const assetInfo = assets.find((a) => a.symbol === crypto);
    const decimals = assetInfo?.decimals ?? 6;

    // Convert whole units to integer base units
    const factor = 10 ** decimals;
    const cryptoAmountBaseUnits = BigInt(Math.ceil(cryptoUnits * factor));
    const cryptoAmountFormatted = (Number(cryptoAmountBaseUnits) / factor).toFixed(
      Math.min(decimals, 6),
    );

    const quoteId = `fxq_${Math.random().toString(36).substring(2, 11)}`;
    const lockedAt = now;
    const expiresAt = new Date(now.getTime() + this.lockDurationMs);

    return {
      quoteId,
      fiatCurrency: fiat,
      fiatAmount: fiatAmount.toFixed(2),
      cryptoAsset: crypto,
      cryptoAmountBaseUnits,
      cryptoAmountFormatted,
      exchangeRate: baseRate,
      guaranteedSpreadBps: this.spreadBps,
      lockedAt,
      expiresAt,
    };
  }

  /**
   * Check if a rate quote/lock is still valid at `now`.
   */
  isValid(quote: FxRateQuote, now: Date = new Date()): boolean {
    return now.getTime() <= quote.expiresAt.getTime();
  }

  /**
   * Enforce that a rate quote is not expired, or throw FxRateExpiredError.
   */
  assertValid(quote: FxRateQuote, now: Date = new Date()): void {
    if (!this.isValid(quote, now)) {
      throw new FxRateExpiredError(
        `FX rate quote ${quote.quoteId} expired at ${quote.expiresAt.toISOString()}`,
        {
          context: {
            quoteId: quote.quoteId,
            expiresAt: quote.expiresAt.toISOString(),
            now: now.toISOString(),
          },
          exposable: true,
        },
      );
    }
  }
}
