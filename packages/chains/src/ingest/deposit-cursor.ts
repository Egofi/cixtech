import type { SqlClient } from "@cixtech/ledger";

/**
 * Durable per-(chain, address) scan cursor for block-range deposit detection
 * (ADR 0016). Records the next block to scan so EVM log scanning is resumable
 * across restarts and shared across nodes — never rescanning from genesis, never
 * skipping a block.
 */
export const CURSOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS deposit_cursor (
  chain      text NOT NULL,
  address    text NOT NULL,
  next_block numeric(78,0) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, address)
);
`;

export class DepositCursorStore {
  constructor(private readonly sql: SqlClient) {}

  /** The next block to scan for (chain, address), or null if never scanned. */
  async get(chain: string, address: string): Promise<bigint | null> {
    const { rows } = await this.sql.query<{ next_block: string }>(
      "SELECT next_block FROM deposit_cursor WHERE chain = $1 AND address = $2",
      [chain, address],
    );
    const raw = rows[0]?.next_block;
    return raw === undefined ? null : BigInt(raw);
  }

  async set(chain: string, address: string, nextBlock: bigint): Promise<void> {
    await this.sql.query(
      `INSERT INTO deposit_cursor (chain, address, next_block, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (chain, address)
       DO UPDATE SET next_block = EXCLUDED.next_block, updated_at = now()`,
      [chain, address, nextBlock.toString()],
    );
  }
}
