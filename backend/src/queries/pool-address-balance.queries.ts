import type { Db } from "@/types";

const CONFLICT = ["chain", "address", "asset"] as const;

export const poolAddressBalance = {
  record: (
    db: Db,
    row: {
      chain: string;
      address: string;
      asset: string;
      balance_base_units: string;
      observed_at: Date;
      source: string;
    },
  ) =>
    db
      .insertInto("pool_address_balance")
      .values({ ...row, last_error: null })
      .onConflict((oc) =>
        oc.columns(CONFLICT).doUpdateSet((eb) => ({
          balance_base_units: eb.ref("excluded.balance_base_units"),
          observed_at: eb.ref("excluded.observed_at"),
          source: eb.ref("excluded.source"),
          last_error: null,
        })),
      ),

  recordFailure: (
    db: Db,
    row: { chain: string; address: string; asset: string; last_error: string },
  ) =>
    db
      .insertInto("pool_address_balance")
      .values({ ...row, balance_base_units: "0", observed_at: new Date(), source: "worker" })
      .onConflict((oc) =>
        oc.columns(CONFLICT).doUpdateSet((eb) => ({ last_error: eb.ref("excluded.last_error") })),
      ),
};
