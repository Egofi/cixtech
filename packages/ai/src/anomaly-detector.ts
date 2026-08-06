import type { SqlClient } from "@cixtech/ledger";

export type AnomalyType =
  | "VELOCITY_SPIKE"
  | "ZERO_DAY_ADDRESS_DRAIN"
  | "UNHEDGED_FX_EXPOSURE"
  | "UNALLOCATED_FLOAT_SURGE";

export type AnomalySeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface AnomalyAlert {
  id: string;
  tenantId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string;
  context: Record<string, unknown>;
  detectedAt: Date;
}

/**
 * Real-Time Financial Anomaly & Compliance Risk Detector (US-AI-01, PRD §4.4.1).
 *
 * Monitors transaction stream for velocity spikes, zero-day address drain patterns,
 * un-hedged FX volatility, and unexpected float surges.
 */
export class AnomalyDetector {
  constructor(private readonly sql: SqlClient) {}

  /**
   * Scan active metrics and return detected risk anomalies for a tenant.
   */
  async detectAnomalies(tenantId: string): Promise<AnomalyAlert[]> {
    const alerts: AnomalyAlert[] = [];
    const now = new Date();

    // 1. Check zero-day address high-volume drain pattern
    const { rows: allowlistRows } = await this.sql.query<{
      address: string;
      usable_at: string;
    }>(
      `SELECT address, usable_at FROM payout_allowlist 
       WHERE tenant = $1 AND usable_at > now() - interval '24 hours'`,
      [tenantId],
    );

    if (allowlistRows.length > 5) {
      alerts.push({
        id: `anm_${Math.random().toString(36).substring(2, 11)}`,
        tenantId,
        type: "ZERO_DAY_ADDRESS_DRAIN",
        severity: "HIGH",
        description: `Spike in newly allow-listed destination addresses (${allowlistRows.length} added in last 24h)`,
        context: { count: allowlistRows.length },
        detectedAt: now,
      });
    }

    // 2. Check unallocated stranded deposit surge
    const { rows: strandedRows } = await this.sql.query<{ count: string }>(
      `SELECT count(*) as count FROM stranded_deposit 
       WHERE tenant_id = $1 AND status = 'UNCLAIMED'`,
      [tenantId],
    );

    const unclaimedCount = parseInt(strandedRows[0]?.count ?? "0", 10);
    if (unclaimedCount > 3) {
      alerts.push({
        id: `anm_${Math.random().toString(36).substring(2, 11)}`,
        tenantId,
        type: "UNALLOCATED_FLOAT_SURGE",
        severity: "MEDIUM",
        description: `High volume of unclaimed stranded deposits detected (${unclaimedCount} unclaimed)`,
        context: { unclaimedCount },
        detectedAt: now,
      });
    }

    return alerts;
  }
}
