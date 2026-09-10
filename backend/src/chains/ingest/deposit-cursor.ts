import { kyselyFor } from "@/postgres";
import { depositCursor } from "@/queries";
import type { Db, SqlClient } from "@/types";

export class DepositCursorStore {
  private readonly db: Db;

  constructor(sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

  async get(chain: string, address: string): Promise<bigint | null> {
    const row = await depositCursor.nextBlock(this.db, chain, address).executeTakeFirst();
    return row === undefined ? null : BigInt(row.next_block);
  }

  async set(chain: string, address: string, nextBlock: bigint): Promise<void> {
    await depositCursor.advance(this.db, chain, address, nextBlock.toString()).execute();
  }
}
