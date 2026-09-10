import { GatherStrategyNotSupportedError, UnknownGatherStrategyError } from "@/common";
import type { GatherPreparation, GatherStrategyKind, PrepareGatherInput } from "@/types";

export const GATHER_STRATEGIES: readonly GatherStrategyKind[] = [
  "EOA_FUND_TRANSFER",
  "FORWARDER",
  "EIP7702",
];

export interface GatherStrategy {
  readonly kind: GatherStrategyKind;

  deriveAddress(chain: string, xpub: string, index: number): string;

  prepare(input: PrepareGatherInput): Promise<GatherPreparation>;
}

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

export function assertStrategySupported(chain: string, kind: GatherStrategyKind, family: string) {
  if (kind === "EIP7702" && family !== "EVM") {
    throw new GatherStrategyNotSupportedError(
      `EIP-7702 is EVM-only; ${chain} (${family}) cannot use it`,
      { context: { chain, family, kind }, exposable: true },
    );
  }
}
