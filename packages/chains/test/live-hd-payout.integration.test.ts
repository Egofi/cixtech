import {
  LEDGER_SCHEMA_SQL,
  LedgerService,
  SqlLedgerStore,
  depositFinalized,
} from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import { PGlite } from "@electric-sql/pglite";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";
import { FetchHttpClient } from "../src/http.js";
import { PayoutService } from "../src/payout/payout-service.js";
import { PolicyEngine } from "../src/payout/policy.js";
import { TronPayoutBroadcaster } from "../src/payout/tron-broadcaster.js";
import { RawTronSigner } from "../src/tron/raw-tron-signer.js";
import { makeTronSigner } from "../src/tron/tron-signer.js";
import { fundedGatherer } from "./pool-fixture.js";

// The production-shaped money-out, LIVE: a payout signed by an HD-DERIVED pool
// key (KeypairSigner), not a raw key. Steps: derive pool address P0 from a test
// engine xprv → fund it with native TRX from the hot wallet → pay TRX out of P0,
// signed by the pool signer at its index. Gated on CIXTECH_LIVE_HD + TRON_PK.
const PK = process.env["TRON_PK"];
const RUN = process.env["CIXTECH_LIVE_HD"] && PK;
const NILE = "https://nile.trongrid.io";

const TRX = Asset("TRX");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");

// A throwaway engine seed (testnet only) → account xprv the pool derives from.
const ENGINE_XPRV = HDKey.fromMasterSeed(
  Uint8Array.from(Buffer.from("cafe".repeat(16), "hex")),
).derive("m/44'/195'/0'").privateExtendedKey;

function wrap(db: PGlite): SqlClient {
  const w = (q: { query: PGlite["query"]; transaction: PGlite["transaction"] }): SqlClient => ({
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await q.query(text, params ? [...params] : []);
      return { rows: r.rows as R[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      return q.transaction((tx) => fn(w(tx as unknown as typeof q)));
    },
  });
  return w(db);
}

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

    // 1. Fund P0 with native TRX from the hot wallet (enough for payout + bandwidth).
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

    // 2. Pay TRX out of P0, signed by the HD pool key at index 0.
    const db = new PGlite();
    await db.exec(LEDGER_SCHEMA_SQL);
    const sql = wrap(db);
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
    expect(res.from).toBe(p0); // paid FROM the HD-derived pool address
    console.log(
      `HD PAYOUT 5 TRX from ${p0} TXID=${res.txId}  (https://nile.tronscan.org/#/transaction/${res.txId})`,
    );
  }, 120_000);
});
