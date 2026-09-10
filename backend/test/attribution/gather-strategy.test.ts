import { EoaFundTransferStrategy } from "@/attribution/eoa-gather-strategy.js";
import { GatherConfigStore } from "@/attribution/gather-config.js";
import type { GatherStrategy } from "@/attribution/gather-strategy.js";
import { GatherStrategyRegistry } from "@/attribution/gather-strategy.js";
import { PoolGatherer } from "@/attribution/pool-gatherer.js";
import { PoolManager } from "@/attribution/pool-manager.js";
import { GATHER_CONFIG_SCHEMA_SQL, POOL_SCHEMA_SQL } from "@/schemas/sql";
import { SqlPoolStore } from "@/stores";
import type { GatherStrategyKind } from "@/types";

import { GatherStrategyNotSupportedError, UnknownGatherStrategyError } from "@/common";
import { freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeDerive } from "./postgres.js";

const T = "t1";
const M = "m1";
const CHAIN = "TRON";

const fake = (kind: GatherStrategyKind): GatherStrategy & { prepared: string[] } => {
  const prepared: string[] = [];
  return {
    kind,
    prepared,
    deriveAddress: (chain, xpub, index) => `${kind}:${chain}:${xpub}:${index}`,
    async prepare(input) {
      prepared.push(input.address);
      return { fundedNativeBaseUnits: 0n };
    },
  };
};

describe("GatherStrategy — per-address dispatch (ADR 0011)", () => {
  it("records the minting strategy on the address and carries it onto the gather leg", async () => {
    const db = await freshDatabase(POOL_SCHEMA_SQL);
    const pool = new PoolManager(new SqlPoolStore(db.sql), fakeDerive, {
      cooldownMs: 1_000,
      activeStrategy: () => "FORWARDER",
    });
    const address = await pool.assign(T, M, CHAIN, "inv-1", "xpub");

    const rows = await pool.addressesForMerchant(T, M, CHAIN);
    expect(rows[0]?.gatherStrategy).toBe("FORWARDER");

    const legs = await new PoolGatherer(pool, {
      async balance() {
        return 500n;
      },
    }).gather(T, M, CHAIN, "USDT", 100n);
    expect(legs).toEqual([
      { address, derivationIndex: 0, gatherStrategy: "FORWARDER", amountBaseUnits: 100n },
    ]);
  });

  it("defaults to fund-then-transfer when no toggle is configured", async () => {
    const db = await freshDatabase(POOL_SCHEMA_SQL);
    const pool = new PoolManager(new SqlPoolStore(db.sql), fakeDerive, { cooldownMs: 1_000 });
    await pool.assign(T, M, CHAIN, "inv-1", "xpub");
    const rows = await pool.addressesForMerchant(T, M, CHAIN);
    expect(rows[0]?.gatherStrategy).toBe("EOA_FUND_TRANSFER");
  });

  it("keeps draining an existing address under its ORIGINAL strategy after the toggle flips", async () => {
    const db = await freshDatabase(POOL_SCHEMA_SQL);
    let active: GatherStrategyKind = "EOA_FUND_TRANSFER";
    const store = new SqlPoolStore(db.sql);
    const pool = new PoolManager(store, fakeDerive, {
      cooldownMs: 1_000,
      activeStrategy: () => active,
    });

    const old = await pool.assign(T, M, CHAIN, "inv-1", "xpub");
    await pool.markInUse(CHAIN, old);
    await pool.cool(CHAIN, old);

    active = "FORWARDER";
    const minted = await pool.assign(T, M, CHAIN, "inv-2", "xpub");
    expect(minted).not.toBe(old);

    const byAddress = new Map(
      (await pool.addressesForMerchant(T, M, CHAIN)).map((r) => [r.address, r.gatherStrategy]),
    );
    expect(byAddress.get(old)).toBe("EOA_FUND_TRANSFER");
    expect(byAddress.get(minted)).toBe("FORWARDER");

    const legs = await new PoolGatherer(pool, {
      async balance(_c, address) {
        return address === old ? 500n : 0n;
      },
    }).gather(T, M, CHAIN, "USDT", 100n);
    expect(legs[0]?.address).toBe(old);
    expect(legs[0]?.gatherStrategy).toBe("EOA_FUND_TRANSFER");
  });

  it("refuses to drain an address whose strategy has no implementation, rather than substituting one", () => {
    const registry = new GatherStrategyRegistry([fake("EOA_FUND_TRANSFER")]);
    expect(() => registry.forAddress("FORWARDER")).toThrow(UnknownGatherStrategyError);

    expect(registry.forAddress("EOA_FUND_TRANSFER").kind).toBe("EOA_FUND_TRANSFER");
  });
});

describe("GatherConfig — the toggle (ADR 0011)", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;

  beforeEach(async () => {
    db = await freshDatabase(GATHER_CONFIG_SCHEMA_SQL);
  });

  it("falls back to fund-then-transfer when nothing is configured", async () => {
    const cfg = new GatherConfigStore(db.sql);
    expect(await cfg.activeFor("TRON", T)).toBe("EOA_FUND_TRANSFER");
  });

  it("lets a tenant row override the chain-wide default", async () => {
    const cfg = new GatherConfigStore(db.sql);
    await cfg.setActive({
      chain: "POLYGON",
      strategy: "EOA_FUND_TRANSFER",
      updatedBy: "ops",
      approvedBy: "sec",
    });
    await cfg.setActive({
      chain: "POLYGON",
      tenant: T,
      strategy: "FORWARDER",
      updatedBy: "ops",
      approvedBy: "sec",
    });
    expect(await cfg.activeFor("POLYGON", T)).toBe("FORWARDER");
    expect(await cfg.activeFor("POLYGON", "other")).toBe("EOA_FUND_TRANSFER");
  });

  it("requires two distinct identities — flipping it is a fund-movement change (§7.4)", async () => {
    const cfg = new GatherConfigStore(db.sql);
    await expect(
      cfg.setActive({
        chain: "POLYGON",
        strategy: "FORWARDER",
        updatedBy: "ops",
        approvedBy: "ops",
      }),
    ).rejects.toThrow(/two distinct identities/);
  });

  it("rejects EIP-7702 off EVM — a capability limit, not a preference", async () => {
    const cfg = new GatherConfigStore(db.sql, (chain) => (chain === "TRON" ? "TRON" : "EVM"));
    await expect(
      cfg.setActive({
        chain: "TRON",
        strategy: "EIP7702",
        updatedBy: "ops",
        approvedBy: "sec",
      }),
    ).rejects.toThrow(GatherStrategyNotSupportedError);

    await expect(
      cfg.setActive({
        chain: "BASE",
        strategy: "EIP7702",
        updatedBy: "ops",
        approvedBy: "sec",
      }),
    ).resolves.toMatchObject({ activeStrategy: "EIP7702" });
  });
});

describe("EoaFundTransferStrategy — gas provisioning (build spec §6.2)", () => {
  const gasNeeded = new Map([["POLYGON", 21_000n]]);

  it("provisions native gas before a token transfer", async () => {
    const calls: Array<{ address: string; min: bigint; key: string }> = [];
    const strategy = new EoaFundTransferStrategy(
      fakeDerive,
      {
        async provision(i) {
          calls.push({ address: i.address, min: i.minNativeBaseUnits, key: i.idempotencyKey });
          return { funded: i.minNativeBaseUnits };
        },
      },
      { gasRequirementBaseUnits: gasNeeded, nativeAssetOf: () => "POL" },
    );

    const out = await strategy.prepare({
      chain: "POLYGON",
      address: "0xpool",
      derivationIndex: 0,
      asset: "USDC",
      amountBaseUnits: 100n,
      idempotencyKey: "intent-1",
    });
    expect(out.fundedNativeBaseUnits).toBe(21_000n);
    expect(calls).toEqual([{ address: "0xpool", min: 21_000n, key: "gas:intent-1" }]);
  });

  it("does not provision when the payout IS the native asset", async () => {
    let called = false;
    const strategy = new EoaFundTransferStrategy(
      fakeDerive,
      {
        async provision() {
          called = true;
          return { funded: 0n };
        },
      },
      { gasRequirementBaseUnits: gasNeeded, nativeAssetOf: () => "POL" },
    );
    const out = await strategy.prepare({
      chain: "POLYGON",
      address: "0xpool",
      derivationIndex: 0,
      asset: "POL",
      amountBaseUnits: 100n,
      idempotencyKey: "intent-1",
    });
    expect(out.fundedNativeBaseUnits).toBe(0n);
    expect(called).toBe(false);
  });

  it("does not provision on a chain whose fee comes out of the transfer (UTXO)", async () => {
    const strategy = new EoaFundTransferStrategy(fakeDerive, undefined, {
      gasRequirementBaseUnits: gasNeeded,
    });
    const out = await strategy.prepare({
      chain: "BTC",
      address: "bc1pool",
      derivationIndex: 0,
      asset: "BTC",
      amountBaseUnits: 100n,
      idempotencyKey: "intent-1",
    });
    expect(out.fundedNativeBaseUnits).toBe(0n);
  });

  it("fails loudly when a chain needs gas but no provisioner is wired", async () => {
    const strategy = new EoaFundTransferStrategy(fakeDerive, undefined, {
      gasRequirementBaseUnits: gasNeeded,
      nativeAssetOf: () => "POL",
    });
    await expect(
      strategy.prepare({
        chain: "POLYGON",
        address: "0xpool",
        derivationIndex: 0,
        asset: "USDC",
        amountBaseUnits: 100n,
        idempotencyKey: "intent-1",
      }),
    ).rejects.toThrow(/no gas provisioner is configured/);
  });
});
