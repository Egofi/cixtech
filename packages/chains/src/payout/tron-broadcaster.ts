import type { Signer } from "@cixtech/signing";
import type { HttpClient } from "../http.js";
import { abiEncodeTransfer, tronAddressToHex } from "../tron/tron-encoding.js";
import { verifiedTronSigningHash } from "../tron/tron-tx-verify.js";
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
  /** The serialized `Transaction.raw` — the bytes txID is the sha256 of, and the
   * only thing worth verifying, since the JSON `raw_data` is not what gets hashed. */
  raw_data_hex?: string;
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
 * the unsigned tx (so we never protobuf-encode), but we do NOT take its word for
 * what it built: `verifiedTronSigningHash` re-derives the hash from the returned
 * body and decodes that body to check the owner, destination, amount and token
 * contract against this request before anything is signed. TRC20 goes through
 * triggersmartcontract, native TRX through createtransaction.
 *
 * Signing the node's `txID` directly — the previous behaviour — meant a hostile
 * or compromised endpoint could return a transfer of the whole balance to its own
 * address and the engine would sign it. See tron-tx-verify.ts.
 */
export class TronPayoutBroadcaster implements PayoutBroadcaster {
  constructor(
    private readonly http: HttpClient,
    private readonly signer: Signer,
    private readonly config: TronBroadcasterConfig,
  ) {}

  private headers(): Record<string, string> {
    return this.config.apiKey ? { "TRON-PRO-API-KEY": this.config.apiKey } : {};
  }

  async send(req: PayoutRequest): Promise<BroadcastResult> {
    const isNative = req.asset === "TRX";
    const tx = isNative ? await this.buildNative(req) : await this.buildTrc20(req);

    // Re-derive the signing hash from the returned body and assert the body is
    // the transfer this payout authorized. Throws TronTxMismatchError otherwise —
    // BEFORE the key is asked for a signature.
    const contract = isNative ? undefined : this.config.tokenContracts[req.asset];
    const hash = verifiedTronSigningHash(tx, {
      ownerHex: tronAddressToHex(req.fromAddress),
      toHex: tronAddressToHex(req.toAddress),
      amountBaseUnits: req.amountBaseUnits,
      ...(contract ? { contractHex: tronAddressToHex(contract) } : {}),
    });
    const signature = Buffer.from(this.signer.signHash(req.fromDerivationIndex, hash)).toString(
      "hex",
    );
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
