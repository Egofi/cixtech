import type { ChainAdapter, ChainDeposit, ChainFamily, FinalityRule } from "../chain-adapter.js";
import { TRANSFER_EVENT_TOPIC } from "./abi.js";
import { toChecksumAddress } from "./address.js";
import { type EvmLog, type EvmRpc, fromQuantity, toQuantity } from "./evm-rpc.js";

/** A 32-byte log topic for a 20-byte address (right-aligned, lower-case). */
export function addressTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return `0x${"0".repeat(24)}${clean}`;
}

const addressFromTopic = (topic: string): string => toChecksumAddress(`0x${topic.slice(-40)}`);

export interface EvmAdapterConfig {
  chain: string;
  confirmations: number;
  /** ERC20 contracts by symbol on this chain (symbol → contract). */
  tokenContracts: Record<string, string>;
}

/**
 * The EVM deposit adapter (ChainAdapter): one implementation for every EVM chain.
 * Detection is ERC20 `Transfer` logs to a watched address, credited only once the
 * block is buried under `confirmations` (§9). Native-gas deposit detection needs
 * block/trace scanning and is a follow-up; the balance provider already reads
 * native balances for gathering.
 */
export class EvmAdapter implements ChainAdapter {
  readonly family: ChainFamily = "EVM";
  private readonly symbolByContract: Map<string, string>;

  constructor(
    private readonly rpc: EvmRpc,
    private readonly config: EvmAdapterConfig,
  ) {
    this.symbolByContract = new Map(
      Object.entries(config.tokenContracts).map(([symbol, addr]) => [addr.toLowerCase(), symbol]),
    );
  }

  get chain(): string {
    return this.config.chain;
  }

  deriveAddress(_xpub: string, _index: number): string {
    throw new Error("use deriveEvmAddress; the adapter derives via the Signer/xpub helper");
  }

  finality(): FinalityRule {
    return { confirmations: this.config.confirmations };
  }

  /** Parse raw `Transfer` logs into deposits, dropping any token we do not track. */
  parseDeposits(raw: unknown): ChainDeposit[] {
    const logs = raw as EvmLog[];
    const out: ChainDeposit[] = [];
    for (const log of logs) {
      if ((log.topics[0] ?? "").toLowerCase() !== TRANSFER_EVENT_TOPIC || log.topics.length < 3) {
        continue;
      }
      const symbol = this.symbolByContract.get(log.address.toLowerCase());
      if (!symbol) continue; // a transfer of some token we do not custody
      out.push({
        chain: this.config.chain,
        txId: log.transactionHash,
        index: Number(fromQuantity(log.logIndex)),
        from: addressFromTopic(log.topics[1] as string),
        to: addressFromTopic(log.topics[2] as string),
        asset: symbol,
        tokenContract: toChecksumAddress(log.address),
        amountBaseUnits: fromQuantity(log.data),
        blockNumber: Number(fromQuantity(log.blockNumber)),
      });
    }
    return out;
  }

  /**
   * Scan inbound ERC20 deposits to `address` over `[fromBlock, head - confirmations]`
   * — only FINAL blocks, so a reorg-able transfer is never credited. Returns the
   * highest block scanned (`scannedTo`) so a durable cursor can advance past it;
   * when nothing is final yet, `scannedTo < fromBlock` and the cursor holds. One
   * query covers every tracked token (filtered by the `to` topic, mapped back to
   * a symbol).
   */
  async scanInboundErc20(
    address: string,
    fromBlock: bigint,
  ): Promise<{ deposits: ChainDeposit[]; scannedTo: bigint }> {
    const head = await this.rpc.blockNumber();
    const safe = head - BigInt(this.config.confirmations);
    if (safe < fromBlock) return { deposits: [], scannedTo: fromBlock - 1n };
    const logs = await this.rpc.getLogs({
      fromBlock: toQuantity(fromBlock),
      toBlock: toQuantity(safe),
      topics: [TRANSFER_EVENT_TOPIC, null, addressTopic(address)],
    });
    return { deposits: this.parseDeposits(logs), scannedTo: safe };
  }

  /** The finalized inbound ERC20 deposits to `address` from `fromBlock` onward. */
  async confirmedInboundErc20(address: string, fromBlock: bigint): Promise<ChainDeposit[]> {
    return (await this.scanInboundErc20(address, fromBlock)).deposits;
  }
}
