import { LEDGER_SCHEMA_SQL, LedgerService, SqlLedgerStore } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import { Asset, LedgerAccountKey } from "@cixtech/types";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type { ChainDeposit } from "../src/chain-adapter.js";
import { type Attribution, DepositIngestor } from "../src/ingest/deposit-ingestor.js";
import { parseTrc20Response } from "../src/tron/trc20.js";

const RECIPIENT = "TRecipient000000000000000000000000";
const USDT = Asset("USDT");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");

// One address book maps the recipient to merchant m1 / tenant t1 at 0.50%.
const attribution: Attribution = {
  async resolve(chain, address) {
    if (chain === "TRON" && address === RECIPIENT) {
      return { tenant: "t1", merchant: "m1", feeBasisPoints: 50 };
    }
    return null;
  },
};

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

async function harness() {
  const db = new PGlite();
  await db.exec(LEDGER_SCHEMA_SQL);
  const ledger = new LedgerService(new SqlLedgerStore(wrap(db)));
  return { ledger, ingestor: new DepositIngestor(ledger, attribution) };
}

const deposit = (): ChainDeposit => {
  const [d] = parseTrc20Response({
    data: [
      {
        transaction_id: "deadbeef",
        from: "TSender",
        to: RECIPIENT,
        type: "Transfer",
        value: "1000000",
        token_info: { symbol: "USDT", address: "TR7NH", decimals: 6 },
      },
    ],
  });
  return d as ChainDeposit;
};

describe("money-in: TRC20 deposit → ledger credit", () => {
  it("credits the merchant minus the 0.5% fee, exactly", async () => {
    const { ledger, ingestor } = await harness();
    expect((await ingestor.ingestConfirmed(deposit())).status).toBe("credited");

    expect(await ledger.getBalance(POOL, USDT)).toBe(1_000_000n); // whole gross in the pool
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(995_000n); // merchant net
    expect(await ledger.availableBalance(FEE, USDT)).toBe(5_000n); // egofi 0.5%
  });

  it("never double-credits a re-observed transaction", async () => {
    const { ledger, ingestor } = await harness();
    await ingestor.ingestConfirmed(deposit());
    expect((await ingestor.ingestConfirmed(deposit())).status).toBe("duplicate");
    expect(await ledger.getBalance(POOL, USDT)).toBe(1_000_000n); // still once
  });

  it("does not credit a deposit to an unknown address", async () => {
    const { ledger, ingestor } = await harness();
    const stray = { ...deposit(), to: "TUnknown" };
    expect((await ingestor.ingestConfirmed(stray)).status).toBe("unmatched");
    expect(await ledger.getBalance(LedgerAccountKey("pool_addr:TRON:m1"), USDT)).toBe(0n);
  });
});
