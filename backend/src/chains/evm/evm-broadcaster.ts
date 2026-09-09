import type { Signer } from "@/signing";
import type { BroadcastResult, Eip1559Tx, EvmBroadcasterConfig, PayoutRequest } from "@/types";
import type { PayoutBroadcaster } from "../payout/broadcaster.js";
import { erc20TransferData } from "./abi.js";
import type { EvmRpc } from "./evm-rpc.js";
import { serializeSigned, signingHash } from "./evm-tx.js";

const NATIVE_GAS_LIMIT = 21_000n;
const ERC20_GAS_LIMIT = 100_000n;
const BASE_FEE_MULTIPLE = 2n;
const FALLBACK_PRIORITY_FEE = 1_500_000_000n;

export class EvmPayoutBroadcaster implements PayoutBroadcaster {
  constructor(
    private readonly rpc: EvmRpc,
    private readonly signer: Signer,
    private readonly config: EvmBroadcasterConfig,
  ) {}

  async send(req: PayoutRequest): Promise<BroadcastResult> {
    const isNative = req.asset.toUpperCase() === this.config.nativeSymbol.toUpperCase();
    if (!isNative && !this.config.tokenContracts[req.asset.toUpperCase()]) {
      throw new Error(`No ERC20 contract configured for ${req.asset}`);
    }

    const [nonce, priorityFee, latest] = await Promise.all([
      this.rpc.nonce(req.fromAddress),
      this.rpc.maxPriorityFeePerGas().catch(() => FALLBACK_PRIORITY_FEE),
      this.rpc.block("latest"),
    ]);
    const maxFeePerGas = latest.baseFeePerGas * BASE_FEE_MULTIPLE + priorityFee;

    const tx: Eip1559Tx = isNative
      ? {
          chainId: this.config.chainId,
          nonce,
          maxPriorityFeePerGas: priorityFee,
          maxFeePerGas,
          gasLimit: NATIVE_GAS_LIMIT,
          to: req.toAddress,
          value: req.amountBaseUnits,
          data: new Uint8Array(0),
        }
      : {
          chainId: this.config.chainId,
          nonce,
          maxPriorityFeePerGas: priorityFee,
          maxFeePerGas,
          gasLimit: ERC20_GAS_LIMIT,
          to: this.config.tokenContracts[req.asset.toUpperCase()] as string,
          value: 0n,
          data: erc20TransferData(req.toAddress, req.amountBaseUnits),
        };

    const signature = this.signer.signHash(req.fromDerivationIndex, signingHash(tx));
    const signed = serializeSigned(tx, signature);
    const txId = await this.rpc.sendRawTransaction(signed.raw);

    if (txId.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new Error(`Broadcast hash mismatch: node ${txId} vs local ${signed.hash}`);
    }
    return { txId: signed.hash };
  }
}
