import { randomUUID } from "node:crypto";
import { kyselyFor } from "@/postgres";
import { anomalyInputs } from "@/queries";
import type { AnomalyAlert, SqlClient } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export class AnomalyDetector {
  constructor(private readonly sql: SqlClient) {}

  async detectAnomalies(tenantId: string): Promise<AnomalyAlert[]> {
    const alerts: AnomalyAlert[] = [];
    const now = new Date();

    const allowlistRows = await anomalyInputs
      .allowlistAddedSince(kyselyFor(this.sql), tenantId, new Date(now.getTime() - DAY_MS))
      .execute();

    if (allowlistRows.length > 5) {
      alerts.push({
        id: `anm_${randomUUID()}`,
        tenantId,
        type: "ZERO_DAY_ADDRESS_DRAIN",
        severity: "HIGH",
        description: `Spike in newly allow-listed destination addresses (${allowlistRows.length} added in last 24h)`,
        context: { count: allowlistRows.length },
        detectedAt: now,
      });
    }

    return alerts;
  }
}
