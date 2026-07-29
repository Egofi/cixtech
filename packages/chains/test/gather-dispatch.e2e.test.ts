import {
  EoaFundTransferStrategy,
  type GatherStrategy,
  type GatherStrategyKind,
  GatherStrategyRegistry,
  POOL_SCHEMA_SQL,
  PoolGatherer,
  PoolManager,
  SqlPoolStore,
  UnknownGatherStrategyError,
} from "@cixtech/attribution";
import {
  LEDGER_SCHEMA_SQL,
  LedgerService,
  SqlLedgerStore,
  depositFinalized,
} from "@cixtech/ledger";
import { freshDatabase } from "@cixtech/testing";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import { describe, expect, it } from "vitest";
import type {
  BroadcastResult,
  PayoutBroadcaster,
  PayoutRequest,
} from "../src/payout/broadcaster.js";
import { PAYOUT_JOURNAL_SCHEMA_SQL, PayoutJournal } from "../src/payout/payout-journal.js";
import { PayoutService } from "../src/payout/payout-service.js";
import { PolicyEngine } from "../src/payout/policy.js";

const T = "t1";
const M = "m1";
const CHAIN = "POLYGON";
const ASSET = "USDC";
const DEST = "0xdestination";
const GAS_PER_TRANSFER = 10_000_000_000_000_000n;

/** Records the exact order of gas top-ups and token transfers. */
class RecordingBroadcaster implements PayoutBroadcaster {
  readonly calls: Array<{ asset: string; to: string; from: string; amount: bigint }> = [];
  async send(req: PayoutRequest): Promise<BroadcastResult> {
    this.calls.push({
      asset: req.asset,
      to: req.toAddress,
      from: req.fromAddress,
      amount: req.amountBaseUnits,
    });
    return { txId: `0x${"a".repeat(63)}${this.calls.length}` };
  }
}

async function harness(strategies: GatherStrategyRegistry, mintAs: GatherStrategyKind) {
  const db = await freshDatabase(
    [LEDGER_SCHEMA_SQL, POOL_SCHEMA_SQL, PAYOUT_JOURNAL_SCHEMA_SQL].join("\n"),
  );
  const ledger = new LedgerService(new SqlLedgerStore(db.sql));
  const pool = new PoolManager(new SqlPoolStore(db.sql), (_c, _x, i) => `0xpool${i}`, {
    cooldownMs: 60_000,
    activeStrategy: () => mintAs,
  });
  const address = await pool.assign(T, M, CHAIN, "inv-1", "xpub");

  // Credit a deposit so the merchant has a liability balance to draw down.
  await ledger.post(
    depositFinalized({
      id: JournalEntryId("d1"),
      idempotencyKey: IdempotencyKey("d1"),
      asset: Asset(ASSET),
      amount: 1_000_000n,
      feeBasisPoints: 0,
      poolAddr: LedgerAccountKey(`pool_addr:${CHAIN}:${M}`),
      merchantAvailable: LedgerAccountKey(`merchant_available:${T}:${M}`),
      feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${T}`),
    }),
  );

  const broadcaster = new RecordingBroadcaster();
  const payouts = new PayoutService(
    ledger,
    new PolicyEngine({ maxPerPayoutBaseUnits: 10n ** 12n, allowlist: new Set([DEST]) }),
    broadcaster,
    new PoolGatherer(pool, {
      async balance() {
        return 1_000_000n;
      },
    }),
    { journal: new PayoutJournal(db.sql), gatherStrategies: strategies },
  );
  return { payouts, broadcaster, address };
}

const payoutParams = (key = "intent-1") => ({
  tenant: T,
  merchant: M,
  chain: CHAIN,
  asset: ASSET,
  amountBaseUnits: 500_000n,
  destination: DEST,
  idempotencyKey: key,
});

describe("payout gather dispatch (ADR 0011 + §6.2)", () => {
  it("provisions native gas into the pool address BEFORE broadcasting the token transfer", async () => {
    const funder = new RecordingBroadcaster();
    const strategies = new GatherStrategyRegistry([
      new EoaFundTransferStrategy(
        (_c, _x, i) => `0xpool${i}`,
        {
          async provision(i) {
            funder.calls.push({
              asset: "POL",
              to: i.address,
              from: "0xtreasury",
              amount: i.minNativeBaseUnits,
            });
            return { funded: i.minNativeBaseUnits };
          },
        },
        {
          gasRequirementBaseUnits: new Map([[CHAIN, GAS_PER_TRANSFER]]),
          nativeAssetOf: () => "POL",
        },
      ),
    ]);
    const { payouts, broadcaster, address } = await harness(strategies, "EOA_FUND_TRANSFER");

    await payouts.payout(payoutParams());

    // The whole point: an ERC-20 transfer is executed BY the pool address, which
    // holds only USDC. Without the top-up first, this broadcast reverts for gas.
    expect(funder.calls).toEqual([
      { asset: "POL", to: address, from: "0xtreasury", amount: GAS_PER_TRANSFER },
    ]);
    expect(broadcaster.calls).toEqual([
      { asset: ASSET, to: DEST, from: address, amount: 500_000n },
    ]);
  });

  it("dispatches on the address's recorded tag, not the current toggle", async () => {
    const seen: GatherStrategyKind[] = [];
    const spy = (kind: GatherStrategyKind): GatherStrategy => ({
      kind,
      deriveAddress: (_c, _x, i) => `0xpool${i}`,
      async prepare() {
        seen.push(kind);
        return { fundedNativeBaseUnits: 0n };
      },
    });
    const strategies = new GatherStrategyRegistry([spy("EOA_FUND_TRANSFER"), spy("FORWARDER")]);
    // Address minted under FORWARDER; the payout must prepare it as a FORWARDER
    // even though EOA is also registered and is the default.
    const { payouts } = await harness(strategies, "FORWARDER");

    await payouts.payout(payoutParams());
    expect(seen).toEqual(["FORWARDER"]);
  });

  it("refuses the payout when the address's strategy has no implementation", async () => {
    // Simulates retiring a strategy while addresses minted under it still hold
    // funds. Substituting another one would broadcast a transfer that cannot move
    // them, so the payout must fail loudly instead.
    const strategies = new GatherStrategyRegistry([
      new EoaFundTransferStrategy((_c, _x, i) => `0xpool${i}`),
    ]);
    const { payouts, broadcaster } = await harness(strategies, "FORWARDER");

    await expect(payouts.payout(payoutParams())).rejects.toBeInstanceOf(UnknownGatherStrategyError);
    expect(broadcaster.calls).toHaveLength(0); // nothing was sent
  });
});
