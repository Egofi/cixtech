/**
 * Fee sweeping is no longer a worker concern. It used to run here on a six-hour
 * timer as a book-only ledger move; it is now a real transfer taken during the
 * payout gather, with the console button as its manual trigger. Its tests live
 * with the primitive in `packages/chains/test/fee-sweep.e2e.test.ts`.
 */
import { freshDatabase } from "@cixtech/testing";
import { describe, expect, it } from "vitest";
import { applySchemas } from "../../api/src/sql.js";
import { SqlPoolGroupEnumerator } from "../src/stores/pool-group-enumerator.js";

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
