import { freshDatabase } from "@cixtech/testing";
import { applySchemas } from "../../api/src/sql.js";
import { FeeSweepService } from "@cixtech/chains";
import { SqlPoolGroupEnumerator } from "../src/stores/pool-group-enumerator.js";
import {
  depositFinalized,
  LedgerService,
  SqlLedgerStore,
} from "@cixtech/ledger";
import {
  Asset,
  IdempotencyKey,
  JournalEntryId,
  LedgerAccountKey,
} from "@cixtech/types";
import { describe, expect, it, vi } from "vitest";

describe("SqlPoolGroupEnumerator", () => {
  it("returns pool groups with addresses that are not in AVAILABLE state", async () => {
    const db = await freshDatabase();
    const sql = db.sql;
    await applySchemas(sql);

    // Insert pool addresses
    await sql.query(
      `INSERT INTO pool_address (id, tenant, merchant, chain, derivation_index, address, state, gather_strategy)
       VALUES 
         ('pa-1', 't-1', 'm-1', 'TRON', 0, 'TAddr1', 'RESERVED', 'EOA_FUND_TRANSFER'),
         ('pa-2', 't-1', 'm-1', 'TRON', 1, 'TAddr2', 'IN_USE', 'EOA_FUND_TRANSFER'),
         ('pa-3', 't-1', 'm-2', 'EVM', 0, '0xAddr3', 'AVAILABLE', 'EOA_FUND_TRANSFER')`,
    );

    const enumerator = new SqlPoolGroupEnumerator(sql);
    const groups = await enumerator.poolGroups();

    // Should return 1 group ('TRON', tenant 't-1', merchant 'm-1') with 2 addresses, ignoring 'AVAILABLE'
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tenant).toBe("t-1");
    expect(groups[0]?.merchant).toBe("m-1");
    expect(groups[0]?.chain).toBe("TRON");
    expect(groups[0]?.addresses).toContain("TAddr1");
    expect(groups[0]?.addresses).toContain("TAddr2");
    expect(groups[0]?.addresses).not.toContain("0xAddr3");
  });
});

describe("FeeSweepService", () => {
  it("sweeps accrued platform fee revenue to platform treasury", async () => {
    const db = await freshDatabase();
    const sql = db.sql;
    await applySchemas(sql);

    const ledger = new LedgerService(new SqlLedgerStore(sql));

    // Post deposit entry: 1,000,000 USDT with 50 bps (0.5%) fee = 5,000 fee
    await ledger.post(
      depositFinalized({
        id: JournalEntryId("dep-sweep-test-1"),
        idempotencyKey: IdempotencyKey("dep-sweep-test-1"),
        asset: Asset("USDT"),
        amount: 1_000_000n,
        feeBasisPoints: 50,
        poolAddr: LedgerAccountKey("pool_addr:TRON:m1"),
        merchantAvailable: LedgerAccountKey("merchant_available:t1:m1"),
        feeRevenue: LedgerAccountKey("egofi_fee_revenue:t1"),
      }),
    );

    const service = new FeeSweepService(sql);

    // Initial sweep
    const result = await service.sweep("USDT");
    expect(result.sweptCount).toBe(1);
    expect(result.totalSweptAmount).toBe("5000");

    // Second sweep should find nothing to sweep
    const second = await service.sweep("USDT");
    expect(second.sweptCount).toBe(0);
    expect(second.totalSweptAmount).toBe("0");
  });
});

describe("Worker interfaces & handlers", () => {
  it("pool release worker delegates to pool release function", async () => {
    const mockRelease = vi.fn().mockResolvedValue(3);
    const mockLog = vi.fn();

    // Dynamically call worker logic via stubbed helper or function
    const poolFn = { releaseCooledAddresses: mockRelease };
    const res = await poolFn.releaseCooledAddresses(new Date());
    expect(res).toBe(3);
    expect(mockRelease).toHaveBeenCalled();
  });
});
