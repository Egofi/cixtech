import { SelfApprovalError } from "@/common";
import { kyselyFor } from "@/postgres";
import type { ApprovalRecord, DB, SqlClient } from "@/types";
import type { Kysely } from "kysely";

export class ApprovalStore {
  private readonly db: Kysely<DB>;

  constructor(sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

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

    const rows = await this.db
      .insertInto("payout_approval")
      .values({ intent_key: input.intentKey, approver: input.approver, tenant: input.tenant })
      .onConflict((oc) => oc.columns(["intent_key", "approver"]).doNothing())
      .returning("approver")
      .execute();

    return { recorded: rows.length > 0 };
  }

  async approversFor(intentKey: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("payout_approval")
      .select("approver")
      .where("intent_key", "=", intentKey)
      .orderBy("at")
      .execute();

    return rows.map((row) => row.approver);
  }

  async listFor(intentKey: string): Promise<ApprovalRecord[]> {
    const rows = await this.db
      .selectFrom("payout_approval")
      .select(["approver", "at"])
      .where("intent_key", "=", intentKey)
      .orderBy("at")
      .execute();

    return rows.map((row) => ({ approver: row.approver, at: new Date(row.at) }));
  }
}
