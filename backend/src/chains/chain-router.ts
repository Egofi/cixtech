import type { AddressBalance } from "@/attribution";
import { UnsupportedChainError } from "@/common";
import type { ChainFamily } from "@/types";
import type { DepositSource } from "./chain-adapter.js";
import type { PayoutBroadcaster } from "./payout/broadcaster.js";

export interface ChainPlugin {
  readonly chain: string;
  readonly family: ChainFamily;
  readonly confirmations: number;
  readonly broadcaster: PayoutBroadcaster;
  readonly balances: AddressBalance;
  readonly depositSource: DepositSource;
  deriveAddress(xpub: string, index: number): string;
}

export class ChainRouter {
  private readonly plugins = new Map<string, ChainPlugin>();

  constructor(plugins: ChainPlugin[] = []) {
    for (const p of plugins) this.register(p);
  }

  register(plugin: ChainPlugin): this {
    this.plugins.set(plugin.chain.toUpperCase(), plugin);
    return this;
  }

  familyOf(chain: string): ChainFamily | undefined {
    return this.plugins.get(chain.toUpperCase())?.family;
  }

  has(chain: string): boolean {
    return this.plugins.has(chain.toUpperCase());
  }

  get(chain: string): ChainPlugin {
    const p = this.plugins.get(chain.toUpperCase());
    if (!p) {
      throw new UnsupportedChainError(`Chain not supported: ${chain}`, {
        context: { chain, supported: this.chains().join(",") },
      });
    }
    return p;
  }

  chains(): string[] {
    return [...this.plugins.keys()];
  }

  readonly broadcaster: PayoutBroadcaster = {
    send: (req) => this.get(req.chain).broadcaster.send(req),
  };

  readonly balances: AddressBalance = {
    balance: (chain, address, asset) => this.get(chain).balances.balance(chain, address, asset),
  };

  readonly depositSource: DepositSource = {
    fetchInbound: (chain, address) => this.get(chain).depositSource.fetchInbound(chain, address),
  };

  readonly deriveAddress = (chain: string, xpub: string, index: number): string =>
    this.get(chain).deriveAddress(xpub, index);
}
