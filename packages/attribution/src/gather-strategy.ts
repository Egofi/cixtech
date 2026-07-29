import { AppError } from "@cixtech/errors";

/**
 * How a pool address is derived and how funds are drained out of it (ADR 0011).
 *
 * These are NOT interchangeable for an address that already holds funds: each kind
 * produces a *different address for the same derivation index* — a CREATE2
 * forwarder is `keccak(factory, salt, initcodeHash)`, a 7702 address is the plain
 * HD EOA. Only the mechanism that minted an address knows how to drain it.
 */
export type GatherStrategyKind = "EOA_FUND_TRANSFER" | "FORWARDER" | "EIP7702";

export const GATHER_STRATEGIES: readonly GatherStrategyKind[] = [
  "EOA_FUND_TRANSFER",
  "FORWARDER",
  "EIP7702",
];

export class UnknownGatherStrategyError extends AppError {
  readonly code = "GATHER_STRATEGY_UNKNOWN";
}

export class GatherStrategyNotSupportedError extends AppError {
  readonly code = "GATHER_STRATEGY_NOT_SUPPORTED";
}

/** What a strategy had to do to make a leg spendable. */
export interface GatherPreparation {
  /** Native base units provisioned into the address (0 when none was needed). */
  fundedNativeBaseUnits: bigint;
}

export interface PrepareGatherInput {
  chain: string;
  /** The pool address the funds will leave from. */
  address: string;
  /** Signer derivation index controlling `address`. */
  derivationIndex: number;
  asset: string;
  amountBaseUnits: bigint;
  /** Dedupe key — preparing twice for the same leg must not fund twice. */
  idempotencyKey: string;
}

/**
 * The gather port (ADR 0011). One implementation is active per `(chain[, tenant])`,
 * but **dispatch is per-address on the strategy each address was minted under**,
 * never on the current toggle — see `GatherStrategyRegistry.forAddress`.
 */
export interface GatherStrategy {
  readonly kind: GatherStrategyKind;
  /** The address this strategy yields for a pool index. Differs per kind, by construction. */
  deriveAddress(chain: string, xpub: string, index: number): string;
  /**
   * Make the address able to send `asset` right now — e.g. provision native gas
   * for an ERC-20/TRC-20 transfer. Must be idempotent on `idempotencyKey`: a
   * retried payout leg must not fund the address a second time.
   */
  prepare(input: PrepareGatherInput): Promise<GatherPreparation>;
}

/**
 * Resolves which strategy handles a given address or mint.
 *
 * The two lookups exist for opposite reasons and must never be confused:
 *
 * - `forMint` reads the **current toggle**, deciding what NEW addresses become.
 * - `forAddress` reads the **tag recorded on the address**, deciding how an
 *   EXISTING address is drained.
 *
 * Dispatching a drain on the toggle instead of the tag is the stranding bug ADR
 * 0011 exists to prevent: flip the toggle and every already-funded address becomes
 * unreachable, because the newly-selected mechanism does not know how to spend it.
 */
export class GatherStrategyRegistry {
  private readonly byKind = new Map<GatherStrategyKind, GatherStrategy>();

  constructor(strategies: readonly GatherStrategy[] = []) {
    for (const s of strategies) this.byKind.set(s.kind, s);
  }

  register(strategy: GatherStrategy): this {
    this.byKind.set(strategy.kind, strategy);
    return this;
  }

  has(kind: GatherStrategyKind): boolean {
    return this.byKind.has(kind);
  }

  kinds(): GatherStrategyKind[] {
    return [...this.byKind.keys()];
  }

  /**
   * The strategy that must drain this address — its recorded tag. A tag with no
   * registered implementation is a loud failure: those funds are reachable only by
   * re-enabling that strategy, and silently falling back to another one would
   * build a transaction that cannot move them.
   */
  forAddress(kind: GatherStrategyKind): GatherStrategy {
    const s = this.byKind.get(kind);
    if (!s) {
      throw new UnknownGatherStrategyError(
        `No implementation registered for gather strategy ${kind}; addresses minted under it cannot be drained`,
        { context: { kind, registered: this.kinds().join(",") }, exposable: false },
      );
    }
    return s;
  }
}

/**
 * EIP-7702 is EVM-only — a capability limit, not a preference (ADR 0011). Config
 * must reject it elsewhere rather than silently accepting and minting addresses
 * nothing can drain.
 */
export function assertStrategySupported(chain: string, kind: GatherStrategyKind, family: string) {
  if (kind === "EIP7702" && family !== "EVM") {
    throw new GatherStrategyNotSupportedError(
      `EIP-7702 is EVM-only; ${chain} (${family}) cannot use it`,
      { context: { chain, family, kind }, exposable: true },
    );
  }
}
