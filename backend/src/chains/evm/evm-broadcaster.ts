import type { Signer } from "@/signing";
import type { BroadcastResult, PayoutBroadcaster, PayoutRequest } from "../payout/broadcaster.js";
import { erc20TransferData } from "./abi.js";
import type { EvmRpc } from "./evm-rpc.js";
import { type Eip1559Tx, serializeSigned, signingHash } from "./evm-tx.js";

const NATIVE_GAS_LIMIT = 21_000n;
const ERC20_GAS_LIMIT = 100_000n; // generous ceiling for a plain transfer
const BASE_FEE_MULTIPLE = 2n; // headroom over the current base fee (EIP-1559)
const FALLBACK_PRIORITY_FEE = 1_500_000_000n; // 1.5 gwei if the node has no tip oracle

export interface EvmBroadcasterConfig {
  chainId: bigint;
  /** ERC20 contracts by symbol on this chain. */
  tokenContracts: Record<string, string>;
  /** Native gas token symbol (POL/BNB/ETH) — a payout of this asset is a value transfer. */
  nativeSymbol: string;
}

/**
 * Builds, signs, and broadcasts an EVM payout as an EIP-1559 (type-2) transaction.
 * A native-asset payout is a plain value transfer; any other asset is an ERC20
 * `transfer` to the token contract. The signing hash goes through the `Signer`
 * port (HD pool key, or MPC), so no key ever lives in this class — identical seam
 * to the Tron broadcaster.
 */
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
    // The node echoes the tx hash; it must match what we computed locally.
    if (txId.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new Error(`Broadcast hash mismatch: node ${txId} vs local ${signed.hash}`);
    }
    return { txId: signed.hash };
  }
}
