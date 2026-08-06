/**
 * Accounting & Refund tables (Phase 3, PRD §3.3).
 * `refund` tracks automated customer refund records.
 */
export const ACCOUNTING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS refund (
  id                        text PRIMARY KEY,
  tenant_id                 text NOT NULL REFERENCES tenant(id),
  merchant_id               text NOT NULL,
  chain                     text NOT NULL,
  asset                     text NOT NULL,
  gross_amount_base_units  numeric(78,0) NOT NULL,
  gas_deduction_base_units numeric(78,0) NOT NULL,
  net_amount_base_units    numeric(78,0) NOT NULL,
  destination_address       text NOT NULL,
  reason                    text NOT NULL,
  tx_id                     text,
  status                    text NOT NULL DEFAULT 'PENDING', -- PENDING | DISPATCHED | SETTLED
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_merchant ON refund(tenant_id, merchant_id);
`;
