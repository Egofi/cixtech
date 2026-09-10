import { FetchHttpClient } from "@/chains/http.js";
import { TronPayoutBroadcaster } from "@/chains/payout/tron-broadcaster.js";
import { RawTronSigner } from "@/chains/tron/raw-tron-signer.js";
import { describe, expect, it } from "vitest";

const PK = process.env["TRON_PK"];
const RUN = process.env["CIXTECH_LIVE_PAYOUT"] && PK;

const NILE_USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

describe.skipIf(!RUN)("LIVE Nile payout (gated on CIXTECH_LIVE_PAYOUT)", () => {
  it("builds, signs, and broadcasts a real USDT payout", async () => {
    const signer = new RawTronSigner(PK as string);
    const broadcaster = new TronPayoutBroadcaster(new FetchHttpClient(), signer, {
      baseUrl: "https://nile.trongrid.io",
      tokenContracts: { USDT: NILE_USDT },
      feeLimitSun: 100_000_000,
    });

    const toAddress = process.env["CIXTECH_PAYOUT_TO"] ?? signer.address;
    const amountBaseUnits = BigInt(process.env["CIXTECH_PAYOUT_AMOUNT"] ?? "1000000");

    const res = await broadcaster.send({
      chain: "TRON",
      asset: "USDT",
      amountBaseUnits,
      fromAddress: signer.address,
      fromDerivationIndex: 0, // raw hot key — index-agnostic
      toAddress,
    });

    expect(res.txId).toMatch(/^[0-9a-f]{64}$/);
    console.log(
      `PAYOUT ${amountBaseUnits} → ${toAddress}\nBROADCAST_TXID=${res.txId}  (https://nile.tronscan.org/#/transaction/${res.txId})`,
    );
  }, 30_000);
});
