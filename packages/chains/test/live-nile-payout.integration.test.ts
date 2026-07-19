import { describe, expect, it } from "vitest";
import { FetchHttpClient } from "../src/http.js";
import { TronPayoutBroadcaster } from "../src/payout/tron-broadcaster.js";
import { RawTronSigner } from "../src/tron/raw-tron-signer.js";

// Gated on CIXTECH_LIVE_PAYOUT + TRON_PK. Broadcasts a REAL Tron transaction on
// Nile, signed by the engine's key — the live money-out counterpart to the live
// money-in. A SELF-transfer (funds return to the same wallet) so the demo loses
// nothing beyond the network/energy fee. The key is read from the env only.
const PK = process.env["TRON_PK"];
const RUN = process.env["CIXTECH_LIVE_PAYOUT"] && PK;

// Nile testnet USDT-TRC20 contract.
const NILE_USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

describe.skipIf(!RUN)("LIVE Nile payout (gated on CIXTECH_LIVE_PAYOUT)", () => {
  it("builds, signs, and broadcasts a real USDT self-transfer", async () => {
    const signer = new RawTronSigner(PK as string);
    const broadcaster = new TronPayoutBroadcaster(new FetchHttpClient(), signer, {
      baseUrl: "https://nile.trongrid.io",
      tokenContracts: { USDT: NILE_USDT },
      feeLimitSun: 100_000_000,
    });

    const res = await broadcaster.send({
      chain: "TRON",
      asset: "USDT",
      amountBaseUnits: 1_000_000n, // 1 USDT, back to our own wallet
      fromAddress: signer.address,
      toAddress: signer.address,
    });

    expect(res.txId).toMatch(/^[0-9a-f]{64}$/);
    console.log(
      `BROADCAST_TXID=${res.txId}  (https://nile.tronscan.org/#/transaction/${res.txId})`,
    );
  }, 30_000);
});
