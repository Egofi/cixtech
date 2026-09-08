import type { AddressBalance } from "@/attribution";
import { AppError } from "@/errors";
import type { ChainFamily, DepositSource } from "./chain-adapter.js";
import type { PayoutBroadcaster } from "./payout/broadcaster.js";

/** A chain not registered with the router was addressed — a loud failure (§16.5). */
export class UnsupportedChainError extends AppError {
  readonly code = "UNSUPPORTED_CHAIN";
}

/**
 * Everything the engine needs to operate ONE chain. Bundled per chain and
 * registered with the router; the engine never touches a plugin directly.
 */
export interface ChainPlugin {
  readonly chain: string;
  readonly family: ChainFamily;
  readonly confirmations: number;
  readonly broadcaster: PayoutBroadcaster;
  readonly balances: AddressBalance;
  readonly depositSource: DepositSource;
  deriveAddress(xpub: string, index: number): string;
}

/**
 * Routes every chain-touching operation to the right chain's plugin (ADR 0016).
 * Because each port already carries the chain, the router IMPLEMENTS those ports
 * by dispatching — so `buildEngine` consumes `router.broadcaster` / `.balances` /
 * `.depositSource` / `.deriveAddress` exactly where it used to consume a single
 * chain's implementation, and the ledger/pool/payout code never changes.
 * Unknown chains throw rather than defaulting.
 */
export class ChainRouter {
  private readonly plugins = new Map<string, ChainPlugin>();

  constructor(plugins: ChainPlugin[] = []) {
    for (const p of plugins) this.register(p);
  }

  register(plugin: ChainPlugin): this {
    this.plugins.set(plugin.chain.toUpperCase(), plugin);
    return this;
  }

  /** A chain's family, or undefined if it is not routed. Used to reject a strategy
   *  the chain structurally cannot run (ADR 0011 — 7702 is EVM-only). */
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

  /** The routable chains, in registration order. */
  chains(): string[] {
    return [...this.plugins.keys()];
  }

  // ── The dispatching ports the engine composes ───────────────────────────────

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
