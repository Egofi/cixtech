/**
 * Checkout & FX Payment Intent tables (Phase 2, PRD §3.1, §3.2).
 * `payment_intent` stores 15-minute guaranteed price locked invoices.
 * `stranded_deposit` tracks unallocated/wrong-network deposits for customer recovery.
 */
export const CHECKOUT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payment_intent (
  id                        text PRIMARY KEY,
  tenant_id                 text NOT NULL REFERENCES tenant(id),
  merchant_id               text NOT NULL,
  amount_fiat               numeric(12,2) NOT NULL,
  fiat_currency             text NOT NULL,
  amount_crypto_base_units  numeric(78,0) NOT NULL,
  crypto_asset              text NOT NULL,
  chain                     text NOT NULL,
  deposit_address           text NOT NULL,
  quote_id                  text NOT NULL,
  rate_locked_at            timestamptz NOT NULL,
  expires_at                timestamptz NOT NULL,
  status                    text NOT NULL DEFAULT 'PENDING', -- PENDING | PAID | EXPIRED | QUARANTINED | REFUNDED
  tx_hash                   text,
  offramp_channel           text,
  offramp_account           text,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_intent_merchant ON payment_intent(tenant_id, merchant_id);
CREATE INDEX IF NOT EXISTS payment_intent_status ON payment_intent(status, expires_at);

CREATE TABLE IF NOT EXISTS stranded_deposit (
  id                  text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenant(id),
  chain               text NOT NULL,
  deposit_address     text NOT NULL,
  tx_hash             text NOT NULL,
  asset               text NOT NULL,
  amount_base_units   numeric(78,0) NOT NULL,
  status              text NOT NULL DEFAULT 'UNCLAIMED', -- UNCLAIMED | CLAIMED | SWEPT
  claimed_destination text,
  claimed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stranded_deposit_tx ON stranded_deposit(chain, tx_hash);
`;
