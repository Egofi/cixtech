import type { Attribution } from "@cixtech/attribution";
import { LEDGER_SCHEMA_SQL, LedgerService, SqlLedgerStore, splitFee } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import { freshDatabase } from "@cixtech/testing";
import { Asset, LedgerAccountKey } from "@cixtech/types";
import { describe, expect, it } from "vitest";
import { FetchHttpClient } from "../src/http.js";
import { DepositIngestor } from "../src/ingest/deposit-ingestor.js";
import { TronAdapter } from "../src/tron/tron-adapter.js";

// Gated on CIXTECH_LIVE_NILE. The FULL money-in round trip against LIVE Nile
// testnet with real funds: fetch a real USDT-TRC20 deposit → parse → ingest →
// credit the real ledger. Nile needs no API key.
const RUN = process.env["CIXTECH_LIVE_NILE"];
const MERCHANT_ADDRESS = "TJkyXySVnHjqo6VDoRNxUoCh524ViKuv5h";
const BPS = 50;

const USDT = Asset("USDT");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");

const attribution: Attribution = {
  async resolve(chain, address) {
    return chain === "TRON" && address === MERCHANT_ADDRESS
      ? { tenant: "t1", merchant: "m1", feeBasisPoints: BPS }
      : null;
  },
};

describe.skipIf(!RUN)("LIVE Nile money-in (gated on CIXTECH_LIVE_NILE)", () => {
  it("credits a real testnet USDT deposit to the ledger, minus 0.5%", async () => {
    const adapter = new TronAdapter(new FetchHttpClient(), {
      baseUrl: "https://nile.trongrid.io",
      confirmations: 19,
    });
    const deposits = (await adapter.fetchInboundTrc20(MERCHANT_ADDRESS)).filter(
      (d) => d.asset === "USDT",
    );
    expect(deposits.length).toBeGreaterThan(0);

    const db = await freshDatabase();
    await db.exec(LEDGER_SCHEMA_SQL);
    const ledger = new LedgerService(new SqlLedgerStore(db.sql));
    const ingestor = new DepositIngestor(ledger, attribution);

    for (const d of deposits) {
      expect((await ingestor.ingestConfirmed(d)).status).toBe("credited");
    }

    let gross = 0n;
    let net = 0n;
    let fee = 0n;
    for (const d of deposits) {
      const s = splitFee(d.amountBaseUnits, BPS);
      gross += d.amountBaseUnits;
      net += s.net;
      fee += s.fee;
    }
    expect(await ledger.getBalance(POOL, USDT)).toBe(gross); // whole gross held in the pool
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(net); // merchant net
    expect(await ledger.availableBalance(FEE, USDT)).toBe(fee); // egofi 0.5%

    // Re-observing the same deposits never double-credits.
    for (const d of deposits) {
      expect((await ingestor.ingestConfirmed(d)).status).toBe("duplicate");
    }
    expect(await ledger.getBalance(POOL, USDT)).toBe(gross);
  }, 30_000);
});
