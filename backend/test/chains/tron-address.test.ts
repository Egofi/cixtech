import {
  accountHash20,
  decodeTronAddress,
  deriveTronAddress,
  tronAddressFromPubkey,
} from "@/chains/tron/address.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex"));

const PK1 = fromHex("0000000000000000000000000000000000000000000000000000000000000001");
const ETH_ADDR_PK1 = "7e5f4552091a69125d5dfcb7b8c2659029395bdf";

describe("tron address derivation", () => {
  it("matches the known key → account-hash vector (EVM-bytes anchor)", () => {
    const pub = secp256k1.getPublicKey(PK1, false);
    expect(hex(accountHash20(pub))).toBe(ETH_ADDR_PK1);
  });

  it("encodes a Tron address as 0x41 || account-hash and round-trips", () => {
    const addr = tronAddressFromPubkey(secp256k1.getPublicKey(PK1, true));
    expect(addr.startsWith("T")).toBe(true);
    const payload = decodeTronAddress(addr);
    expect(payload).toHaveLength(21);
    expect(payload[0]).toBe(0x41);
    expect(hex(payload.subarray(1))).toBe(ETH_ADDR_PK1);
  });

  it("derives distinct, valid addresses per BIP44 index from an xpub", () => {
    const seed = fromHex("000102030405060708090a0b0c0d0e0f");
    const xpub = HDKey.fromMasterSeed(seed).derive("m/44'/195'/0'").publicExtendedKey;
    const a0 = deriveTronAddress(xpub, 0);
    const a1 = deriveTronAddress(xpub, 1);
    expect(a0).not.toBe(a1);
    for (const a of [a0, a1]) {
      const p = decodeTronAddress(a);
      expect(p).toHaveLength(21);
      expect(p[0]).toBe(0x41);
    }
  });

  it("rejects a negative derivation index", () => {
    expect(() => deriveTronAddress("xpub-unused", -1)).toThrow();
  });
});
