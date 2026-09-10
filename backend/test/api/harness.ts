import { buildApp } from "@/api/app.js";
import { buildEngine } from "@/api/engine.js";
import { applySchemas } from "@/api/sql.js";
import { tenantScopedSql } from "@/api/tenant-scope.js";
import { SqlKillSwitch } from "@/stores";
import type { BroadcastResult, PayoutRequest, SqlClient } from "@/types";

import type { AddressBalance } from "@/attribution";
import {
  ChainRouter,
  type DepositSource,
  type PayoutBroadcaster,
  PolicyEngine,
  type WebhookPoster,
  deriveTronAddress,
} from "@/chains";

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

  extraChains?: ConstructorParameters<typeof ChainRouter>[0];

  wrapSql?: (sql: SqlClient) => SqlClient;

  corsOrigins?: readonly string[];
}

export const ADMIN_TOKEN = "test-admin-token";

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

export async function makeApi(o: Overrides = {}) {
  const db = await freshDatabase();

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
