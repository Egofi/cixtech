import { randomUUID } from "node:crypto";
import type { PayoutService } from "@cixtech/chains";
import { AppError } from "@cixtech/errors";
import type { SqlClient } from "@cixtech/ledger";

export class StrandedDepositNotFoundError extends AppError {
  readonly code = "STRANDED_DEPOSIT_NOT_FOUND";
}

export class DepositAlreadyClaimedError extends AppError {
  readonly code = "DEPOSIT_ALREADY_CLAIMED";
}

export type StrandedDepositStatus = "UNCLAIMED" | "CLAIMED" | "SWEPT";

export interface StrandedDeposit {
  id: string;
  tenantId: string;
  chain: string;
  depositAddress: string;
  txHash: string;
  asset: string;
  amountBaseUnits: string;
  status: StrandedDepositStatus;
  claimedDestination: string | null;
  claimedAt: string | null;
  createdAt: string;
}

export interface RegisterStrandedInput {
  tenantId: string;
  chain: string;
  depositAddress: string;
  txHash: string;
  asset: string;
  amountBaseUnits: bigint;
}

export class RecoveryService {
  constructor(
    private readonly sql: SqlClient,
    private readonly payouts?: PayoutService,
  ) {}

  async registerUnallocated(input: RegisterStrandedInput): Promise<StrandedDeposit> {
    const id = `rec_${randomUUID().replace(/-/g, "")}`;
    await this.sql.query(
      `INSERT INTO stranded_deposit (
        id, tenant_id, chain, deposit_address, tx_hash, asset, amount_base_units, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'UNCLAIMED')
      ON CONFLICT DO NOTHING`,
      [
        id,
        input.tenantId,
        input.chain.toUpperCase(),
        input.depositAddress,
        input.txHash,
        input.asset.toUpperCase(),
        input.amountBaseUnits.toString(),
      ],
    );
    return this.getByTx(input.chain, input.txHash);
  }

  async getByTx(chain: string, txHash: string): Promise<StrandedDeposit> {
    const { rows } = await this.sql.query<{
      id: string;
      tenant_id: string;
      chain: string;
      deposit_address: string;
      tx_hash: string;
      asset: string;
      amount_base_units: string;
      status: string;
      claimed_destination: string | null;
      claimed_at: string | null;
      created_at: string;
    }>(
      "SELECT * FROM stranded_deposit WHERE chain = $1 AND tx_hash = $2",
      [chain.toUpperCase(), txHash],
    );

    const r = rows[0];
    if (!r) {
      throw new StrandedDepositNotFoundError(
        `No stranded deposit found for tx ${txHash} on ${chain}`,
        { context: { chain, txHash }, exposable: true },
      );
    }

    return {
      id: r.id,
      tenantId: r.tenant_id,
      chain: r.chain,
      depositAddress: r.deposit_address,
      txHash: r.tx_hash,
      asset: r.asset,
      amountBaseUnits: r.amount_base_units,
      status: r.status as StrandedDepositStatus,
      claimedDestination: r.claimed_destination,
      claimedAt: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async claim(
    chain: string,
    txHash: string,
    destinationAddress: string,
  ): Promise<{ deposit: StrandedDeposit; sweepTxId?: string }> {
    const record = await this.getByTx(chain, txHash);

    if (record.status !== "UNCLAIMED") {
      throw new DepositAlreadyClaimedError(
        `Stranded deposit ${txHash} was already claimed/swept`,
        { context: { txHash, status: record.status }, exposable: true },
      );
    }

    const now = new Date();
    await this.sql.query(
      `UPDATE stranded_deposit 
       SET status = 'CLAIMED', claimed_destination = $3, claimed_at = $4
       WHERE chain = $1 AND tx_hash = $2`,
      [chain.toUpperCase(), txHash, destinationAddress, now.toISOString()],
    );

    let sweepTxId: string | undefined;

    // Trigger auto-sweep via payout service if configured
    if (this.payouts) {
      try {
        const res = await this.payouts.payout({
          tenant: record.tenantId,
          merchant: "RECOVERY",
          chain: record.chain,
          asset: record.asset,
          amountBaseUnits: BigInt(record.amountBaseUnits),
          destination: destinationAddress,
          idempotencyKey: `recovery:${record.id}`,
        });
        sweepTxId = res.txId;
        await this.sql.query(
          "UPDATE stranded_deposit SET status = 'SWEPT' WHERE id = $1",
          [record.id],
        );
      } catch (err) {
        // Log & leave in CLAIMED status for manual/retry processing
        console.error(`Auto-sweep failed for stranded deposit ${record.id}:`, err);
      }
    }

    const updated = await this.getByTx(chain, txHash);
    return { deposit: updated, ...(sweepTxId ? { sweepTxId } : {}) };
  }
}
