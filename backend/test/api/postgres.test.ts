import { provisionAppRole } from "@/api/app-role.js";
import { checkRlsEffective, withTenant } from "@/api/rls.js";
import { applySchemas } from "@/api/sql.js";
import { depositFinalized } from "@/ledger";
import { LedgerService } from "@/services";
import { SqlLedgerStore } from "@/stores";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import { type TestDatabase, freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

describe("Postgres guarantees", () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await freshDatabase();
    await applySchemas(db.sql);
  });

  const entryFor = (id: string, amount: bigint) =>
    depositFinalized({
      id: JournalEntryId(id),
      idempotencyKey: IdempotencyKey(id),
      asset: Asset("USDT"),
      amount,
      feeBasisPoints: 50,
      poolAddr: LedgerAccountKey("pool_addr:TRON:m"),
      merchantPending: LedgerAccountKey("merchant_pending:t:m"),
      merchantAvailable: LedgerAccountKey("merchant_available:t:m"),
      feeRevenue: LedgerAccountKey("egofi_fee_revenue:t"),
    });

  it("commits a whole journal entry as one unit across a pooled connection", async () => {
    const ledger = new LedgerService(new SqlLedgerStore(db.sql));
    const id = "atomic-1";

    expect((await ledger.post(entryFor(id, 1_000_000n))).applied).toBe(true);
    expect((await ledger.post(entryFor(id, 1_000_000n))).applied).toBe(false);

    const postings = await db.sql.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM posting WHERE journal_entry_id = $1",
      [id],
    );
    expect(Number(postings.rows[0]?.n)).toBeGreaterThan(1);
  });

  it("rolls the whole transaction back when the unit of work throws", async () => {
    await expect(
      db.sql.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO journal_entry (id, idempotency_key, kind, occurred_at) VALUES ($1,$1,'test',now())",
          ["rollback-1"],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const left = await db.sql.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entry WHERE id = $1",
      ["rollback-1"],
    );
    expect(left.rows[0]?.n).toBe("0");
  });

  it("nests via SAVEPOINT: an inner failure does not discard the outer work", async () => {
    await db.sql.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO journal_entry (id, idempotency_key, kind, occurred_at) VALUES ($1,$1,'test',now())",
        ["outer"],
      );
      await expect(
        tx.transaction(async (nested) => {
          await nested.query(
            "INSERT INTO journal_entry (id, idempotency_key, kind, occurred_at) VALUES ($1,$1,'test',now())",
            ["inner"],
          );
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
    });

    const rows = await db.sql.query<{ id: string }>(
      "SELECT id FROM journal_entry WHERE id IN ('outer','inner')",
    );
    expect(rows.rows.map((r) => r.id)).toEqual(["outer"]);
  });

  it("does not lose concurrent balance updates to the same account", async () => {
    const ledger = new LedgerService(new SqlLedgerStore(db.sql));
    const account = LedgerAccountKey("merchant_available:t:m");
    const N = 8;

    await Promise.all(
      Array.from({ length: N }, (_, i) => ledger.post(entryFor(`conc-${i}`, 1_000_000n))),
    );

    expect(await ledger.getBalance(account, Asset("USDT"))).toBe(BigInt(-995_000 * N));
  });

  it("deduplicates racing appends of the same entry instead of raising on the primary key", async () => {
    const ledger = new LedgerService(new SqlLedgerStore(db.sql));
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ledger.post(entryFor("race", 1_000_000n))),
    );

    expect(results.filter((r) => r.applied)).toHaveLength(1);
  });

  describe("least-privileged application role", () => {
    it("is subject to row-level security, unlike the owner", async () => {
      expect((await checkRlsEffective(db.sql)).bypasses).toBe(true);
      const app = await db.asAppRole();
      expect((await checkRlsEffective(app.sql)).bypasses).toBe(false);
    });

    it("isolates tenants inside withTenant, while the admin plane still reads across them", async () => {
      const app = await db.asAppRole();
      for (const t of ["ta", "tb"]) {
        await db.sql.query("INSERT INTO tenant (id, name) VALUES ($1, $1)", [t]);
        await db.sql.query("INSERT INTO account (id, tenant_id) VALUES ($1, $2)", [`${t}-a`, t]);
      }

      const seen = await withTenant(app.sql, "ta", (tx) =>
        tx.query<{ tenant_id: string }>("SELECT tenant_id FROM account"),
      );
      expect(seen.rows.map((r) => r.tenant_id)).toEqual(["ta"]);

      const all = await app.sql.query<{ tenant_id: string }>("SELECT tenant_id FROM account");
      expect(all.rows.map((r) => r.tenant_id).sort()).toEqual(["ta", "tb"]);
    });

    it("cannot mutate the append-only financial and audit trails (ADR 0010)", async () => {
      const role = `cixtech_app_${db.schema}`;
      await provisionAppRole(db.sql, role);
      const url = new URL(process.env["CIXTECH_TEST_PG_URL"] as string);
      url.username = role;
      url.password = "x";

      for (const table of ["journal_entry", "posting", "admin_audit", "error_log"]) {
        const perms = await db.sql.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.table_privileges
            WHERE grantee = $1 AND table_name = $2 AND table_schema = current_schema()`,
          [role, table],
        );
        const granted = perms.rows.map((r) => r.privilege_type).sort();
        expect(granted, `${table} grants`).toContain("SELECT");
        expect(granted, `${table} grants`).toContain("INSERT");
        expect(granted, `${table} must not be updatable`).not.toContain("UPDATE");
        expect(granted, `${table} must not be deletable`).not.toContain("DELETE");
      }

      const poolPerms = await db.sql.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.table_privileges
          WHERE grantee = $1 AND table_name = 'pool_address' AND table_schema = current_schema()`,
        [role],
      );
      expect(poolPerms.rows.map((r) => r.privilege_type)).toContain("UPDATE");
    });
  });
});

describe("shared-config rows under tenant isolation (ADR 0011)", () => {
  it("keeps the chain-wide gather default readable inside withTenant, but not another tenant's override", async () => {
    const db = await freshDatabase();
    await applySchemas(db.sql);
    const app = await db.asAppRole();

    await db.sql.query(
      `INSERT INTO gather_config (chain, tenant, active_strategy, updated_by, approved_by)
       VALUES ('POLYGON', '', 'EOA_FUND_TRANSFER', 'ops', 'sec'),
              ('POLYGON', 'ta', 'FORWARDER', 'ops', 'sec'),
              ('POLYGON', 'tb', 'FORWARDER', 'ops', 'sec')`,
    );

    const seen = await withTenant(app.sql, "ta", (tx) =>
      tx.query<{ tenant: string }>("SELECT tenant FROM gather_config ORDER BY tenant"),
    );

    expect(seen.rows.map((r) => r.tenant)).toEqual(["", "ta"]);
  });
});
