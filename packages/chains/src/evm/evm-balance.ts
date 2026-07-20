import type { AddressBalance } from "@cixtech/attribution";
import { erc20BalanceOfData } from "./abi.js";
import { type EvmRpc, fromQuantity } from "./evm-rpc.js";

/**
 * On-chain balance for the pool gatherer (ADR 0009 §6.3): native gas token via
 * eth_getBalance, ERC20 via `balanceOf`. `tokenContracts` maps a symbol to its
 * contract on this chain; the native symbol (POL/BNB/ETH) has no contract.
 */
export class EvmBalanceProvider implements AddressBalance {
  constructor(
    private readonly rpc: EvmRpc,
    private readonly tokenContracts: Record<string, string>,
    private readonly nativeSymbol: string,
  ) {}

  async balance(_chain: string, address: string, asset: string): Promise<bigint> {
    if (asset.toUpperCase() === this.nativeSymbol.toUpperCase()) {
      return this.rpc.nativeBalance(address);
    }
    const contract = this.tokenContracts[asset.toUpperCase()];
    if (!contract) return 0n;
    const hex = `0x${Buffer.from(erc20BalanceOfData(address)).toString("hex")}`;
    return fromQuantity(await this.rpc.ethCall(contract, hex));
  }
}
