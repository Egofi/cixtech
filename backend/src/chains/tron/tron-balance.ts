import type { AddressBalance } from "@/attribution";
import type { HttpClient } from "../http.js";

interface AccountResponse {
  data?: Array<{ balance?: number; trc20?: Array<Record<string, string>> }>;
}

/**
 * Reads a Tron address's on-chain balance for the gatherer (ADR 0009 §6.3):
 * native TRX from the account `balance`, TRC20 from the account's `trc20` map.
 * The gatherer needs the real on-chain balance to pick a funded payout source.
 */
export class TronBalanceProvider implements AddressBalance {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly tokenContracts: Record<string, string>,
    private readonly apiKey?: string,
  ) {}

  async balance(_chain: string, address: string, asset: string): Promise<bigint> {
    const headers: Record<string, string> = this.apiKey ? { "TRON-PRO-API-KEY": this.apiKey } : {};
    const res = await this.http.getJson<AccountResponse>(
      `${this.baseUrl}/v1/accounts/${address}`,
      headers,
    );
    const account = res.data?.[0];
    if (!account) return 0n;

    if (asset.toUpperCase() === "TRX") return BigInt(account.balance ?? 0);

    const contract = this.tokenContracts[asset.toUpperCase()];
    if (!contract) return 0n;
    for (const entry of account.trc20 ?? []) {
      const bal = entry[contract];
      if (bal !== undefined) return BigInt(bal);
    }
    return 0n;
  }
}
