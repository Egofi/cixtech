import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";
import { tronAddressFromPubkey } from "../src/tron/address.js";
import { RawTronSigner } from "../src/tron/raw-tron-signer.js";
import { abiEncodeTransfer, tronAddressToHex } from "../src/tron/tron-encoding.js";

const TJKY = "TJkyXySVnHjqo6VDoRNxUoCh524ViKuv5h";
// Real hex for TJky (its 0x41 address), confirmed against the Nile faucet tx.
const TJKY_HEX = "416068e61a64410617446c09f76e23358fe95f3b3e";

describe("tron payout encoding", () => {
  it("encodes a base58 address to its 0x41 hex form", () => {
    expect(tronAddressToHex(TJKY)).toBe(TJKY_HEX);
  });

  it("ABI-encodes transfer(to, amount) as 32-byte address ‖ 32-byte amount", () => {
    const enc = abiEncodeTransfer(TJKY, 1_000_000n);
    expect(enc).toHaveLength(128);
    expect(enc.slice(0, 64)).toBe(`000000000000000000000000${TJKY_HEX.slice(2)}`);
    expect(enc.slice(64)).toBe((1_000_000).toString(16).padStart(64, "0"));
  });

  it("rejects a non-positive transfer amount", () => {
    expect(() => abiEncodeTransfer(TJKY, 0n)).toThrow();
  });
});

describe("RawTronSigner", () => {
  // A throwaway key (NOT a funded one) — proves the signing primitive only.
  const PK = "0000000000000000000000000000000000000000000000000000000000000001";

  it("is a Signer whose signature recovers to its address (index-agnostic)", () => {
    const signer = new RawTronSigner(PK);
    expect(signer.address.startsWith("T")).toBe(true);
    expect(signer.deriveAddress(0)).toBe(signer.address); // one key, any index

    const hash = Uint8Array.from(Buffer.from("abcd1234".repeat(8), "hex"));
    const sig = signer.signHash(0, hash);
    expect(sig).toHaveLength(65);

    const recovered = secp256k1.Signature.fromCompact(sig.subarray(0, 64))
      .addRecoveryBit(sig[64] as number)
      .recoverPublicKey(hash)
      .toRawBytes(true);
    expect(tronAddressFromPubkey(recovered)).toBe(signer.address);
  });
});
