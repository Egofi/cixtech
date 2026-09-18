import type { AddressBalance } from "@/attribution";
import {
  type GasFloatSource,
  type GasFunder,
  GasStation,
  LedgerGasFloat,
  TreasuryGasFloat,
} from "@/chains/treasury/gas-station.js";
import { LedgerService } from "@/services";
import { MemoryLedgerStore } from "@/stores";
import type { GasStationConfig } from "@/types";
import { describe, expect, it } from "vitest";

const TREASURY = "0xtreasury";
const POOL = "0xpool";
const PER_TRANSFER = 21_000n;
const FLOOR = PER_TRANSFER * 10n;

const configs = new Map<string, GasStationConfig>([
  ["POLYGON", { nativeAsset: "POL", floorBaseUnits: FLOOR }],
]);

/** Balances keyed `chain/address/asset`; anything unlisted is zero, as a chain reports it. */
function balancesOf(seed: Record<string, bigint>): AddressBalance {
  return {
    async balance(chain, address, asset) {
      return seed[`${chain}/${address}/${asset}`] ?? 0n;
    },
  };
}

function recordingFunder(): GasFunder & { calls: Array<{ address: string; min: bigint }> } {
  const calls: Array<{ address: string; min: bigint }> = [];
  return {
    calls,
    async fund(input) {
      calls.push({ address: input.address, min: input.minNativeBaseUnits });
      return { funded: input.minNativeBaseUnits };
    },
  };
}

const treasuryOf = () => ({ address: TREASURY });

describe("TreasuryGasFloat — the float is the balance that actually pays", () => {
  it("reads the gas treasury's native balance on the chain", async () => {
    const float = new TreasuryGasFloat(
      balancesOf({ [`POLYGON/${TREASURY}/POL`]: 500_000n }),
      treasuryOf,
    );
    expect(await float.available("POLYGON", "POL")).toBe(500_000n);
  });

  it("reports zero when no gas treasury is configured", async () => {
    const float = new TreasuryGasFloat(balancesOf({}), () => undefined);
    expect(await float.available("POLYGON", "POL")).toBe(0n);
  });
});

describe("GasStation — provisioning a token payout's gas", () => {
  it("funds the pool address when the treasury is above the floor", async () => {
    const funder = recordingFunder();
    const station = new GasStation(
      new TreasuryGasFloat(balancesOf({ [`POLYGON/${TREASURY}/POL`]: FLOOR }), treasuryOf),
      configs,
      funder,
    );

    const out = await station.provision({
      chain: "POLYGON",
      address: POOL,
      minNativeBaseUnits: PER_TRANSFER,
      idempotencyKey: "intent-1",
    });

    expect(out.funded).toBe(PER_TRANSFER);
    expect(funder.calls).toEqual([{ address: POOL, min: PER_TRANSFER }]);
  });

  it("refuses, without funding, when the treasury is below the floor", async () => {
    const funder = recordingFunder();
    const station = new GasStation(
      new TreasuryGasFloat(balancesOf({ [`POLYGON/${TREASURY}/POL`]: FLOOR - 1n }), treasuryOf),
      configs,
      funder,
    );

    await expect(
      station.provision({
        chain: "POLYGON",
        address: POOL,
        minNativeBaseUnits: PER_TRANSFER,
        idempotencyKey: "intent-1",
      }),
    ).rejects.toMatchObject({ code: "GAS_FLOAT_DEPLETED" });
    expect(funder.calls).toEqual([]);
  });

  it("classifies a dry float as retryable 503, not as a bad request", async () => {
    const station = new GasStation(
      new TreasuryGasFloat(balancesOf({}), treasuryOf),
      configs,
      recordingFunder(),
    );

    const err = await station
      .provision({
        chain: "POLYGON",
        address: POOL,
        minNativeBaseUnits: PER_TRANSFER,
        idempotencyKey: "intent-1",
      })
      .catch((e: unknown) => e);

    // Topping up the treasury makes the same request succeed, so the caller is
    // told to retry rather than told it sent something invalid.
    expect(err).toMatchObject({ code: "GAS_FLOAT_DEPLETED", status: 503, retryable: true });
    // The tenant learns nothing about the size of our gas float.
    expect((err as { isExposable(): boolean }).isExposable()).toBe(false);
  });

  it("names the missing configuration rather than blaming the float when there is no funder", async () => {
    const station = new GasStation(
      new TreasuryGasFloat(balancesOf({ [`POLYGON/${TREASURY}/POL`]: FLOOR }), treasuryOf),
      configs,
      undefined,
    );

    // An operator who has not set the treasury variables must be sent to that,
    // not to a depleted-float message about a treasury that does not exist.
    await expect(
      station.provision({
        chain: "POLYGON",
        address: POOL,
        minNativeBaseUnits: PER_TRANSFER,
        idempotencyKey: "intent-1",
      }),
    ).rejects.toMatchObject({
      code: "GAS_TREASURY_NOT_CONFIGURED",
      message: expect.stringContaining("CIXTECH_GAS_TREASURY_ADDRESS"),
    });
  });
});

describe("regression: a float source that always reads zero freezes token payouts", () => {
  /**
   * `gas_float:{chain}` is credited by nothing in this engine — `payoutSettled`
   * and `feeSwept` take an optional `networkFee` leg and no caller supplies one.
   * Wiring the ledger-backed source in production therefore reported every chain
   * as depleted and refused every ERC-20/TRC-20 payout before broadcast.
   *
   * This pins both halves: the empty ledger really does read zero, and the
   * source the engine actually ships does not.
   */
  it("the ledger-backed float reads zero on a ledger with no gas postings", async () => {
    const empty: GasFloatSource = new LedgerGasFloat(new LedgerService(new MemoryLedgerStore()));
    expect(await empty.available("POLYGON", "POL")).toBe(0n);

    const funder = recordingFunder();
    const station = new GasStation(empty, configs, funder);
    await expect(
      station.provision({
        chain: "POLYGON",
        address: POOL,
        minNativeBaseUnits: PER_TRANSFER,
        idempotencyKey: "intent-1",
      }),
    ).rejects.toMatchObject({ code: "GAS_FLOAT_DEPLETED" });
    expect(funder.calls).toEqual([]);
  });

  it("the shipped treasury-backed float funds the same payout", async () => {
    const funder = recordingFunder();
    const station = new GasStation(
      new TreasuryGasFloat(balancesOf({ [`POLYGON/${TREASURY}/POL`]: FLOOR }), treasuryOf),
      configs,
      funder,
    );

    await expect(
      station.provision({
        chain: "POLYGON",
        address: POOL,
        minNativeBaseUnits: PER_TRANSFER,
        idempotencyKey: "intent-1",
      }),
    ).resolves.toEqual({ funded: PER_TRANSFER });
  });
});
