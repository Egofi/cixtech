import type { ChainDeposit, EvmDepositSourceConfig } from "@/types";
import type { DepositSource } from "../chain-adapter.js";
import type { DepositCursorStore } from "../ingest/deposit-cursor.js";
import type { EvmAdapter } from "./evm-adapter.js";
import type { EvmRpc } from "./evm-rpc.js";

export class EvmDepositSource implements DepositSource {
  constructor(
    private readonly adapter: EvmAdapter,
    private readonly rpc: EvmRpc,
    private readonly cursors: DepositCursorStore,
    private readonly config: EvmDepositSourceConfig,
  ) {}

  async fetchInbound(chain: string, address: string): Promise<ChainDeposit[]> {
    let cursor = await this.cursors.get(chain, address);
    if (cursor === null) {
      const head = await this.rpc.blockNumber();
      const lookback = BigInt(this.config.initialLookbackBlocks);
      cursor = head > lookback ? head - lookback : 0n;
    }

    const { deposits, scannedTo } = await this.adapter.scanInboundErc20(address, cursor);

    if (scannedTo >= cursor) await this.cursors.set(chain, address, scannedTo + 1n);
    return deposits;
  }
}
