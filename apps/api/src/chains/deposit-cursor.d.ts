import type { SqlClient } from "@cixtech/ledger";
/**
 * Durable per-(chain, address) scan cursor for block-range deposit detection
 * (ADR 0016). Records the next block to scan so EVM log scanning is resumable
 * across restarts and shared across nodes — never rescanning from genesis, never
 * skipping a block.
 */
export declare const CURSOR_SCHEMA_SQL = "\nCREATE TABLE IF NOT EXISTS deposit_cursor (\n  chain      text NOT NULL,\n  address    text NOT NULL,\n  next_block numeric(78,0) NOT NULL,\n  updated_at timestamptz NOT NULL DEFAULT now(),\n  PRIMARY KEY (chain, address)\n);\n";
export declare class DepositCursorStore {
    private readonly sql;
    constructor(sql: SqlClient);
    /** The next block to scan for (chain, address), or null if never scanned. */
    get(chain: string, address: string): Promise<bigint | null>;
    set(chain: string, address: string, nextBlock: bigint): Promise<void>;
}
