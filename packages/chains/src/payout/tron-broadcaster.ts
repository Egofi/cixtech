import type { HttpClient } from "../http.js";
import type { RawTronSigner } from "../tron/raw-tron-signer.js";
import { abiEncodeTransfer, tronAddressToHex } from "../tron/tron-encoding.js";
import type { BroadcastResult, PayoutBroadcaster, PayoutRequest } from "./broadcaster.js";

export interface TronBroadcasterConfig {
  baseUrl: string;
  apiKey?: string;
  /** TRC20 token contracts by symbol (e.g. USDT → its Nile/mainnet address, from config). */
  tokenContracts: Record<string, string>;
  /** Max SUN to burn for energy on a TRC20 transfer. */
  feeLimitSun?: number;
}

interface BuiltTx {
  txID: string;
  [k: string]: unknown;
}
interface TriggerResponse {
  result?: { result?: boolean; message?: string };
  transaction?: BuiltTx;
}
interface BroadcastResponse {
  result?: boolean;
  txid?: string;
  code?: string;
  message?: string;
}

/**
 * Builds, signs, and broadcasts a Tron payout (build spec §16). The node builds
 * the unsigned tx (so we never protobuf-encode); we sign its txID with the key
 * that controls the from-address, and broadcast. TRC20 goes through
 * triggersmartcontract, native TRX through createtransaction.
 */
export class TronPayoutBroadcaster implements PayoutBroadcaster {
  constructor(
    private readonly http: HttpClient,
    private readonly signer: RawTronSigner,
    private readonly config: TronBroadcasterConfig,
  ) {}

  private headers(): Record<string, string> {
    return this.config.apiKey ? { "TRON-PRO-API-KEY": this.config.apiKey } : {};
  }

  async send(req: PayoutRequest): Promise<BroadcastResult> {
    const tx = req.asset === "TRX" ? await this.buildNative(req) : await this.buildTrc20(req);
    const signature = this.signer.signTxId(tx.txID);
    const res = await this.http.postJson<BroadcastResponse>(
      `${this.config.baseUrl}/wallet/broadcasttransaction`,
      { ...tx, signature: [signature] },
      this.headers(),
    );
    if (!res.result) {
      throw new Error(
        `Tron broadcast failed: ${res.code ?? ""} ${res.message ?? JSON.stringify(res)}`,
      );
    }
    return { txId: tx.txID };
  }

  private async buildTrc20(req: PayoutRequest): Promise<BuiltTx> {
    const contract = this.config.tokenContracts[req.asset];
    if (!contract) throw new Error(`No TRC20 contract configured for ${req.asset}`);
    const built = await this.http.postJson<TriggerResponse>(
      `${this.config.baseUrl}/wallet/triggersmartcontract`,
      {
        owner_address: tronAddressToHex(req.fromAddress),
        contract_address: tronAddressToHex(contract),
        function_selector: "transfer(address,uint256)",
        parameter: abiEncodeTransfer(req.toAddress, req.amountBaseUnits),
        fee_limit: this.config.feeLimitSun ?? 100_000_000,
        call_value: 0,
        visible: false,
      },
      this.headers(),
    );
    if (!built.transaction?.txID) {
      throw new Error(
        `triggersmartcontract failed: ${built.result?.message ?? JSON.stringify(built)}`,
      );
    }
    return built.transaction;
  }

  private async buildNative(req: PayoutRequest): Promise<BuiltTx> {
    const built = await this.http.postJson<BuiltTx & { Error?: string }>(
      `${this.config.baseUrl}/wallet/createtransaction`,
      {
        owner_address: tronAddressToHex(req.fromAddress),
        to_address: tronAddressToHex(req.toAddress),
        amount: Number(req.amountBaseUnits),
        visible: false,
      },
      this.headers(),
    );
    if (!built.txID)
      throw new Error(`createtransaction failed: ${built.Error ?? JSON.stringify(built)}`);
    return built;
  }
}
