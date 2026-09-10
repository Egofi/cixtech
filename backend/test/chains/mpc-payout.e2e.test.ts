import type { HttpClient } from "@/chains/http.js";
import { TronPayoutBroadcaster } from "@/chains/payout/tron-broadcaster.js";
import { tronAddressFromPubkey } from "@/chains/tron/address.js";
import { tronAddressToHex } from "@/chains/tron/tron-encoding.js";
import { dkg, thresholdSignerFromShares } from "@/mpc";
import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";
import { builtTx, trc20Calldata, trc20RawData, txIdFor } from "./tron-fixtures.js";

const DEST = "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW";
const NILE_USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const AMOUNT = 1_000_000n;

class FakeHttp implements HttpClient {
  broadcastBody: Record<string, unknown> | undefined;
  rawDataHex = "";
  constructor(private readonly from: () => string) {}
  async getJson<T>(): Promise<T> {
    throw new Error("unused");
  }
  async postJson<T>(url: string, body: unknown): Promise<T> {
    if (url.endsWith("/triggersmartcontract")) {
      this.rawDataHex = trc20RawData(
        tronAddressToHex(this.from()),
        tronAddressToHex(NILE_USDT),
        trc20Calldata(tronAddressToHex(DEST), AMOUNT),
      );
      return { result: { result: true }, transaction: builtTx(this.rawDataHex) } as T;
    }
    this.broadcastBody = body as Record<string, unknown>;
    return { result: true } as T;
  }
}

describe("MPC ThresholdSigner drives a Tron payout (drop-in Signer)", () => {
  it("signs a payout with 3-of-5 nodes; the broadcast signature recovers to the threshold address", async () => {
    const { shares, publicKey } = dkg(3, 5);
    const signer = thresholdSignerFromShares(shares, publicKey, tronAddressFromPubkey);
    const from = signer.deriveAddress(0);
    expect(from.startsWith("T")).toBe(true);

    const http = new FakeHttp(() => from);
    const broadcaster = new TronPayoutBroadcaster(http, signer, {
      baseUrl: "https://nile.trongrid.io",
      tokenContracts: { USDT: NILE_USDT },
    });

    const res = await broadcaster.send({
      chain: "TRON",
      asset: "USDT",
      amountBaseUnits: AMOUNT,
      fromAddress: from,
      fromDerivationIndex: 0,
      toAddress: DEST,
    });
    expect(res.txId).toBe(txIdFor(http.rawDataHex));

    const sigHex = (res && (http.broadcastBody?.["signature"] as string[]))?.[0];
    const sig = Uint8Array.from(Buffer.from(sigHex as string, "hex"));
    const recovered = secp256k1.Signature.fromCompact(sig.subarray(0, 64))
      .addRecoveryBit(sig[64] as number)
      .recoverPublicKey(Uint8Array.from(Buffer.from(txIdFor(http.rawDataHex), "hex")))
      .toRawBytes(true);
    expect(tronAddressFromPubkey(recovered)).toBe(from);
  });
});
