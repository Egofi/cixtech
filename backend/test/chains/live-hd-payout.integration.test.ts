import { FetchHttpClient } from "@/chains/http.js";
import { LEDGER_SCHEMA_SQL } from "@/schemas/sql";
import { LedgerService, PayoutService } from "@/services";
import { SqlLedgerStore } from "@/stores";

import { PolicyEngine } from "@/chains/payout/policy.js";
import { TronPayoutBroadcaster } from "@/chains/payout/tron-broadcaster.js";
import { RawTronSigner } from "@/chains/tron/raw-tron-signer.js";
import { makeTronSigner } from "@/chains/tron/tron-signer.js";
import { depositFinalized } from "@/ledger";

import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey, type SqlClient } from "@/types";
import { HDKey } from "@scure/bip32";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";
import { fundedGatherer } from "./pool-fixture.js";

const PK = process.env["TRON_PK"];
const RUN = process.env["CIXTECH_LIVE_HD"] && PK;
const NILE = "https://nile.trongrid.io";

const TRX = Asset("TRX");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");

const ENGINE_XPRV = HDKey.fromMasterSeed(
  Uint8Array.from(Buffer.from("cafe".repeat(16), "hex")),
).derive("m/44'/195'/0'").privateExtendedKey;

const http = new FetchHttpClient();

async function trxBalance(address: string): Promise<bigint> {
  const d = await http.getJson<{ data?: { balance?: number }[] }>(`${NILE}/v1/accounts/${address}`);
  return BigInt(d.data?.[0]?.balance ?? 0);
}

async function waitForAtLeast(address: string, sun: bigint, tries = 20): Promise<bigint> {
  for (let i = 0; i < tries; i++) {
    const bal = await trxBalance(address);
    if (bal >= sun) return bal;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out waiting for ${address} to reach ${sun} SUN`);
}

describe.skipIf(!RUN)("LIVE HD pool-key payout (gated on CIXTECH_LIVE_HD)", () => {
  it("funds an HD-derived pool address, then pays out of it signed by the pool key", async () => {
    const poolSigner = makeTronSigner(ENGINE_XPRV);
    const p0 = poolSigner.deriveAddress(0);
    const hotSigner = new RawTronSigner(PK as string);

    const funder = new TronPayoutBroadcaster(http, hotSigner, {
      baseUrl: NILE,
      tokenContracts: {},
    });
    const fund = await funder.send({
      chain: "TRON",
      asset: "TRX",
      amountBaseUnits: 15_000_000n, // 15 TRX
      fromAddress: hotSigner.address,
      fromDerivationIndex: 0,
      toAddress: p0,
    });
    console.log(`FUND P0=${p0} TXID=${fund.txId}`);
    await waitForAtLeast(p0, 10_000_000n);

    const db = await freshDatabase();
    await db.exec(LEDGER_SCHEMA_SQL);
    const sql = db.sql;
    const ledger = new LedgerService(new SqlLedgerStore(sql));
    await ledger.post(
      depositFinalized({
        id: JournalEntryId("dep"),
        idempotencyKey: IdempotencyKey("dep"),
        asset: TRX,
        amount: 15_000_000n,
        feeBasisPoints: 0,
        poolAddr: POOL,
        merchantAvailable: AVAILABLE,
        feeRevenue: LedgerAccountKey("egofi_fee_revenue:t1"),
      }),
    );
    const gatherer = await fundedGatherer(db, sql, {
      tenant: "t1",
      merchant: "m1",
      chain: "TRON",
      address: p0,
    });
    const service = new PayoutService(
      ledger,
      new PolicyEngine({
        maxPerPayoutBaseUnits: 10_000_000n,
        allowlist: new Set([hotSigner.address]),
      }),
      new TronPayoutBroadcaster(http, poolSigner, { baseUrl: NILE, tokenContracts: {} }),
      gatherer,
    );

    const res = await service.payout({
      tenant: "t1",
      merchant: "m1",
      chain: "TRON",
      asset: "TRX",
      amountBaseUnits: 5_000_000n, // 5 TRX back to the hot wallet
      destination: hotSigner.address,
      idempotencyKey: `hd-${Date.now()}`,
    });

    expect(res.txId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.from).toBe(p0);
    console.log(
      `HD PAYOUT 5 TRX from ${p0} TXID=${res.txId}  (https://nile.tronscan.org/#/transaction/${res.txId})`,
    );
  }, 120_000);
});
