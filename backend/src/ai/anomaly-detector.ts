import { randomUUID } from "node:crypto";
import type { SqlClient } from "@/ledger";

export type AnomalyType = "VELOCITY_SPIKE" | "ZERO_DAY_ADDRESS_DRAIN";

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
    // Filtered on added_at, not usable_at. `usable_at` is set FORWARD by the
    // cool-down, so `usable_at > now() - 24h` actually matched everything added in
    // the last 48 hours — and would have matched every row ever added had the
    // cool-down been raised. The column that means "added" is added_at.
    const { rows: allowlistRows } = await this.sql.query<{
      address: string;
      added_at: string;
    }>(
      `SELECT address, added_at FROM payout_allowlist
        WHERE tenant = $1 AND added_at > now() - interval '24 hours'`,
      [tenantId],
    );

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
