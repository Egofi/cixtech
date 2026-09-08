import type { Attribution } from "@/attribution";
import type { ChainDeposit } from "@/chains/chain-adapter.js";
import { DepositIngestor } from "@/chains/ingest/deposit-ingestor.js";
import { parseTrc20Response } from "@/chains/tron/trc20.js";
import { LEDGER_SCHEMA_SQL, LedgerService, SqlLedgerStore } from "@/ledger";
import type { SqlClient } from "@/ledger";
import { Asset, LedgerAccountKey } from "@/types";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";

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

async function harness() {
  const db = await freshDatabase();
  await db.exec(LEDGER_SCHEMA_SQL);
  const ledger = new LedgerService(new SqlLedgerStore(db.sql));
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
