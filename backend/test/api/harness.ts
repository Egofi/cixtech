import { buildApp } from "@/api/app.js";
import { buildEngine } from "@/api/engine.js";
import { applySchemas } from "@/api/sql.js";
import { tenantScopedSql } from "@/api/tenant-scope.js";
import type { WebhookPoster } from "@/api/webhooks.js";
import type { AddressBalance } from "@/attribution";
import {
  type BroadcastResult,
  ChainRouter,
  type DepositSource,
  type PayoutBroadcaster,
  type PayoutRequest,
  PolicyEngine,
  SqlKillSwitch,
  deriveTronAddress,
} from "@/chains";
import type { SqlClient } from "@/ledger";
import { HDKey } from "@scure/bip32";
import { freshDatabase } from "@test/support/index.js";

export const DEST = "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW";
export const ENGINE_XPUB = HDKey.fromMasterSeed(
  Uint8Array.from(Buffer.from("00112233445566778899aabbccddeeff", "hex")),
).derive("m/44'/195'/0'").publicExtendedKey;

export class FakeBroadcaster implements PayoutBroadcaster {
  sent: PayoutRequest[] = [];
  async send(req: PayoutRequest): Promise<BroadcastResult> {
    this.sent.push(req);
    return { txId: `${"a".repeat(63)}${this.sent.length}` };
  }
}

const plentiful: AddressBalance = {
  async balance() {
    return 10n ** 30n;
  },
};
const noopPoster: WebhookPoster = {
  async post() {
    return { ok: true, status: 200 };
  },
};
const noDeposits: DepositSource = {
  async fetchInbound() {
    return [];
  },
};

export interface Overrides {
  depositSource?: DepositSource;
  webhookPoster?: WebhookPoster;
  policy?: PolicyEngine;
  adminToken?: string;
  /** Extra chain plugins to register beyond the default TRON fake (for multi-chain tests). */
  extraChains?: ConstructorParameters<typeof ChainRouter>[0];
  /**
   * Wrap the raw client BEFORE the tenant scope wraps it, so a test can observe
   * the statements the engine actually issues — including the `set_config` that
   * binds row-level security.
   */
  wrapSql?: (sql: SqlClient) => SqlClient;
  /** Browser origins allowed to call the API (the consoles' static hosts). */
  corsOrigins?: readonly string[];
}

export const ADMIN_TOKEN = "test-admin-token";

/** A one-chain (or more) router of fakes, mirroring how prod wires the real router. */
function fakeRouter(o: Overrides, broadcaster: PayoutBroadcaster): ChainRouter {
  const router = new ChainRouter([
    {
      chain: "TRON",
      family: "TRON",
      confirmations: 19,
      broadcaster,
      balances: plentiful,
      depositSource: o.depositSource ?? noDeposits,
      deriveAddress: (xpub, index) => deriveTronAddress(xpub, index),
    },
  ]);
  for (const plugin of o.extraChains ?? []) router.register(plugin);
  return router;
}

/** Build a full API + engine on a fresh Postgres schema, with overridable chain edges. */
export async function makeApi(o: Overrides = {}) {
  const db = await freshDatabase();
  // Mirrors production wiring: the engine sees the tenant-scoped client, so the
  // RLS GUC is bound on every authenticated request (§13) in tests too.
  await applySchemas(db.sql);
  const sql = tenantScopedSql(o.wrapSql ? o.wrapSql(db.sql) : db.sql);
  const broadcaster = new FakeBroadcaster();
  const engine = buildEngine({
    sql,
    chains: fakeRouter(o, broadcaster),
    policy:
      o.policy ??
      new PolicyEngine({
        maxPerPayoutBaseUnits: 1_000_000_000n,
        allowlist: new Set([DEST]),
        // Same durable kill-switch the admin console toggles, so admin controls
        // actually gate tenant payouts (mirrors production wiring).
        killSwitch: new SqlKillSwitch(sql),
      }),
    webhookPoster: o.webhookPoster ?? noopPoster,
    engineXpub: ENGINE_XPUB,
    feeBasisPoints: 50,
  });
  const { tenant, apiKey } = await engine.tenants.createTenant("acme");
  return {
    db,
    sql,
    engine,
    broadcaster,
    tenant,
    apiKey,
    app: await buildApp(engine, {
      logger: false,
      ...(o.corsOrigins ? { corsOrigins: o.corsOrigins } : {}),
      admin: {
        token: o.adminToken ?? ADMIN_TOKEN,
        limits: {
          maxPerPayout: "1000000000",
          velocityWindowMs: 86_400_000,
          velocityMax: "10000000000",
        },
      },
    }),
  };
}

export const auth = (apiKey: string) => ({ "x-api-key": apiKey });
export const adminAuth = (token: string = ADMIN_TOKEN) => ({ authorization: `Bearer ${token}` });
