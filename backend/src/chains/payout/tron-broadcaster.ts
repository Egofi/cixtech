import type { Signer } from "@/signing";
import type { BroadcastResult, PayoutRequest, TronBroadcasterConfig } from "@/types";
import type { HttpClient } from "../http.js";
import { abiEncodeTransfer, tronAddressToHex } from "../tron/tron-encoding.js";
import { verifiedTronSigningHash } from "../tron/tron-tx-verify.js";
import type { PayoutBroadcaster } from "./broadcaster.js";

interface BuiltTx {
  txID: string;

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
