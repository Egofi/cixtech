import { AppError } from "@/errors";
import type { SqlClient } from "@/ledger";

/**
 * Collected approvals for a payout intent (build spec §7.4).
 *
 * The primary key is `(intent_key, approver)`, which is the whole dual-control
 * property in one constraint: an approver can press the button as many times as
 * they like and still count once. "M-of-N approvals" has to mean M *distinct*
 * operators, or one compromised credential clears any threshold by repeating
 * itself.
 */
export const PAYOUT_APPROVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payout_approval (
  intent_key text NOT NULL,
  approver   text NOT NULL,
  tenant     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_key, approver)
);
CREATE INDEX IF NOT EXISTS payout_approval_tenant ON payout_approval(tenant, intent_key);
`;

/** No such withdrawal for this tenant. */
export class WithdrawalNotFoundError extends AppError {
  readonly code = "WITHDRAWAL_NOT_FOUND";
}

/** The requester tried to approve their own payout — separation of duties (§7.4). */
export class SelfApprovalError extends AppError {
  readonly code = "POLICY_SELF_APPROVAL";
}

export interface ApprovalRecord {
  approver: string;
  at: Date;
}

export class ApprovalStore {
  constructor(private readonly sql: SqlClient) {}

  /**
   * Record an approval. Rejects the requester approving their own intent — the
   * one rule that makes M-of-N mean anything, checked here rather than only in the
   * policy engine so it holds no matter which caller records the approval.
   */
  async approve(input: {
    tenant: string;
    intentKey: string;
    approver: string;
    requestedBy: string | null;
  }): Promise<{ recorded: boolean }> {
    if (!input.approver) {
      throw new SelfApprovalError("An approval needs an identifiable approver", {
        exposable: true,
      });
    }
    if (input.requestedBy && input.requestedBy === input.approver) {
      throw new SelfApprovalError(
        "The requester of a payout can never approve it (separation of duties)",
        { context: { intentKey: input.intentKey }, exposable: true },
      );
    }
    const r = await this.sql.query<{ approver: string }>(
      `INSERT INTO payout_approval (intent_key, approver, tenant)
       VALUES ($1, $2, $3)
       ON CONFLICT (intent_key, approver) DO NOTHING
       RETURNING approver`,
      [input.intentKey, input.approver, input.tenant],
    );
    return { recorded: r.rows.length > 0 };
  }

  /** Distinct approver identities for an intent, oldest first. */
  async approversFor(intentKey: string): Promise<string[]> {
    const r = await this.sql.query<{ approver: string }>(
      "SELECT approver FROM payout_approval WHERE intent_key = $1 ORDER BY at",
      [intentKey],
    );
    return r.rows.map((row) => row.approver);
  }

  async listFor(intentKey: string): Promise<ApprovalRecord[]> {
    const r = await this.sql.query<{ approver: string; at: string }>(
      "SELECT approver, at FROM payout_approval WHERE intent_key = $1 ORDER BY at",
      [intentKey],
    );
    return r.rows.map((row) => ({ approver: row.approver, at: new Date(row.at) }));
  }
}
