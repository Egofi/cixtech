import { GatherLease } from "@/attribution/gather-lease.js";
import { GATHER_LEASE_SCHEMA_SQL } from "@/schemas/sql";
import { freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

let lease: GatherLease;

beforeEach(async () => {
  const db = await freshDatabase();
  await db.exec(GATHER_LEASE_SCHEMA_SQL);
  lease = new GatherLease(db.sql, 60_000);
});

describe("only one thing may spend a merchant's pool at a time", () => {
  it("admits the first holder and excludes the second", async () => {
    expect(await lease.acquire("t1", "m1", "TRON", "payout-a")).toBe(true);
    expect(await lease.acquire("t1", "m1", "TRON", "sweep-b")).toBe(false);
  });

  it("lets the next holder in once released", async () => {
    await lease.acquire("t1", "m1", "TRON", "payout-a");
    await lease.release("t1", "m1", "TRON", "payout-a");
    expect(await lease.acquire("t1", "m1", "TRON", "sweep-b")).toBe(true);
  });

  it("scopes the lease to one merchant and chain", async () => {
    await lease.acquire("t1", "m1", "TRON", "payout-a");
    expect(await lease.acquire("t1", "m2", "TRON", "payout-b")).toBe(true);
    expect(await lease.acquire("t1", "m1", "BASE", "payout-c")).toBe(true);
  });

  it("can be taken over after it expires", async () => {
    const shortLived = new GatherLease((lease as unknown as { sql: never }).sql, 1_000);
    const t0 = new Date();
    expect(await shortLived.acquire("t1", "m1", "TRON", "crashed", t0)).toBe(true);

    const stillLive = new Date(t0.getTime() + 500);
    expect(await shortLived.acquire("t1", "m1", "TRON", "next", stillLive)).toBe(false);

    const afterExpiry = new Date(t0.getTime() + 1_500);
    expect(await shortLived.acquire("t1", "m1", "TRON", "next", afterExpiry)).toBe(true);
  });

  it("a stale holder cannot release the lease it lost", async () => {
    const t0 = new Date();
    const shortLived = new GatherLease((lease as unknown as { sql: never }).sql, 1_000);
    await shortLived.acquire("t1", "m1", "TRON", "crashed", t0);
    await shortLived.acquire("t1", "m1", "TRON", "next", new Date(t0.getTime() + 1_500));

    await shortLived.release("t1", "m1", "TRON", "crashed");
    expect(
      await shortLived.acquire("t1", "m1", "TRON", "third", new Date(t0.getTime() + 1_600)),
    ).toBe(false);
  });

  it("releases the lease even when the work throws", async () => {
    await expect(
      lease.withLease("t1", "m1", "TRON", "payout-a", async () => {
        throw new Error("broadcast failed");
      }),
    ).rejects.toThrow("broadcast failed");
    expect(await lease.acquire("t1", "m1", "TRON", "sweep-b")).toBe(true);
  });
});
