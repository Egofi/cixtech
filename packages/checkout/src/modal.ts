import { assetRegistry } from "@cixtech/chain-config";

export interface WalletProviderInfo {
  id: string;
  name: string;
  chainFamily: "EVM" | "TRON" | "SOLANA";
  icon: string;
  installed: boolean;
}

export interface PaymentIntentDetails {
  id: string;
  amountFiat: string;
  fiatCurrency: string;
  cryptoAsset: string;
  amountCryptoFormatted: string;
  amountCryptoBaseUnits: string;
  chain: string;
  depositAddress: string;
  expiresAt: string;
  status: "PENDING" | "PAID" | "EXPIRED" | "QUARANTINED" | "REFUNDED";
}

export interface GasSponsorshipOptions {
  sponsorGas: boolean; // Merchant sponsors network gas fee
  paymasterUrl?: string;
}

/**
 * Smart Multi-Chain Checkout Modal SDK (US-CHK-01, PRD §3.1.1).
 *
 * Provides auto-chain detection, wallet inspection, gas sponsorship (Paymaster),
 * and dynamic payment QR code generation for e-commerce checkouts.
 */
export class CheckoutModal {
  private readonly baseUrl: string;

  constructor(options: { baseUrl?: string } = {}) {
    this.baseUrl = options.baseUrl ?? "https://pay.cixtech.com";
  }

  /**
   * Inspect available injected wallet providers in the browser environment.
   */
  detectWallets(): WalletProviderInfo[] {
    const globalObj =
      typeof globalThis !== "undefined"
        ? (globalThis as unknown as Record<string, unknown>)
        : {};

    const hasEthereum = Boolean(globalObj["ethereum"]);
    const hasTronLink = Boolean(globalObj["tronLink"] || globalObj["tronWeb"]);
    const hasPhantom = Boolean(globalObj["phantom"]);

    return [
      {
        id: "metamask",
        name: "MetaMask / EVM Wallet",
        chainFamily: "EVM",
        icon: "metamask-icon",
        installed: hasEthereum,
      },
      {
        id: "tronlink",
        name: "TronLink",
        chainFamily: "TRON",
        icon: "tronlink-icon",
        installed: hasTronLink,
      },
      {
        id: "phantom",
        name: "Phantom",
        chainFamily: "SOLANA",
        icon: "phantom-icon",
        installed: hasPhantom,
      },
    ];
  }

  /**
   * Calculate Paymaster gas sponsorship or network fee estimation.
   */
  calculateGasSponsorship(
    chain: string,
    asset: string,
    options: GasSponsorshipOptions = { sponsorGas: true },
  ): { sponsored: boolean; estimatedFeeFiat: string; feeAsset: string } {
    const cleanChain = chain.toUpperCase();
    const cleanAsset = asset.toUpperCase();

    if (options.sponsorGas) {
      return { sponsored: true, estimatedFeeFiat: "0.00", feeAsset: cleanAsset };
    }

    // Standard baseline gas fee estimates per chain
    const estimatedFeesUsd: Record<string, number> = {
      POLYGON: 0.02,
      BSC: 0.05,
      ARBITRUM: 0.1,
      BASE: 0.05,
      TRON: 0.8,
    };

    const feeUsd = estimatedFeesUsd[cleanChain] ?? 0.1;
    return {
      sponsored: false,
      estimatedFeeFiat: feeUsd.toFixed(2),
      feeAsset: cleanAsset,
    };
  }

  /**
   * Generate URI payload for dynamic payment QR code (e.g. tron:TAddress?amount=10&token=USDT).
   */
  generateQrPayload(intent: PaymentIntentDetails): string {
    const chain = intent.chain.toUpperCase();
    const address = intent.depositAddress;
    const amount = intent.amountCryptoFormatted;
    const asset = intent.cryptoAsset.toUpperCase();

    if (chain === "TRON") {
      return `tron:${address}?amount=${amount}&token=${asset}&intent=${intent.id}`;
    }

    if (chain === "ETHEREUM" || chain === "POLYGON" || chain === "BASE" || chain === "ARBITRUM") {
      return `ethereum:${address}?value=${amount}&token=${asset}&intent=${intent.id}`;
    }

    return `${address}?amount=${amount}&asset=${asset}&intent=${intent.id}`;
  }

  /**
   * Render hosted payment URL for an intent ID.
   */
  getHostedCheckoutUrl(intentId: string): string {
    return `${this.baseUrl}/checkout/${intentId}`;
  }
}
