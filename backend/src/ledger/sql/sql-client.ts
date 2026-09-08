/**
 * The `SqlClient` port now lives in `@cixtech/types` so a driver adapter can
 * implement it without depending on this package. Re-exported here to keep the
 * ledger's existing import path stable.
 */
export type { SqlClient, SqlResult } from "@/types";
