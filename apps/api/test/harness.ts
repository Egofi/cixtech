import type { AddressBalance } from "@cixtech/attribution";
import {
  type BroadcastResult,
  type PayoutBroadcaster,
  type PayoutRequest,
  PolicyEngine,
  deriveTronAddress,
} from "@cixtech/chains";
import { PGlite } from "@electric-sql/pglite";
import { HDKey } from "@scure/bip32";
import { buildApp } from "../src/app.js";
import type { DepositSource } from "../src/detection.js";
import { buildEngine } from "../src/engine.js";
import { applySchemas, pgliteClient } from "../src/sql.js";
import type { WebhookPoster } from "../src/webhooks.js";

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
}

/** Build a full API + engine on a fresh PGlite, with overridable chain edges. */
export async function makeApi(o: Overrides = {}) {
  const db = new PGlite();
  await applySchemas(db);
  const sql = pgliteClient(db);
  const broadcaster = new FakeBroadcaster();
  const engine = buildEngine({
    sql,
    broadcaster,
    balances: plentiful,
    policy:
      o.policy ??
      new PolicyEngine({ maxPerPayoutBaseUnits: 1_000_000_000n, allowlist: new Set([DEST]) }),
    depositSource: o.depositSource ?? noDeposits,
    webhookPoster: o.webhookPoster ?? noopPoster,
    engineXpub: ENGINE_XPUB,
    deriveAddress: (_chain, xpub, index) => deriveTronAddress(xpub, index),
    feeBasisPoints: 50,
  });
  const { tenant, apiKey } = await engine.tenants.createTenant("acme");
  return { db, sql, engine, broadcaster, tenant, apiKey, app: buildApp(engine) };
}

export const auth = (apiKey: string) => ({ "x-api-key": apiKey });
