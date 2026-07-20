import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import { erc20BalanceOfData, erc20TransferData, selector } from "../src/evm/abi.js";
import { deriveEvmAddress, evmAddressFromPubkey, toChecksumAddress } from "../src/evm/address.js";
import { type Eip1559Tx, serializeSigned, signingHash } from "../src/evm/evm-tx.js";

describe("EIP-55 checksum addresses", () => {
  it("matches the canonical checksum vectors", () => {
    for (const a of [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ]) {
      expect(toChecksumAddress(a.toLowerCase())).toBe(a);
    }
  });

  it("derives a stable, checksummed address from an xpub", () => {
    const xpub =
      "xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz";
    const a = deriveEvmAddress(xpub, 0);
    expect(a).toBe(toChecksumAddress(a)); // already checksummed
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(deriveEvmAddress(xpub, 0)).toBe(a); // deterministic
    expect(deriveEvmAddress(xpub, 1)).not.toBe(a);
  });
});

describe("ERC20 ABI encoding", () => {
  it("uses the canonical transfer selector 0xa9059cbb", () => {
    expect(bytesToHex(selector("transfer(address,uint256)"))).toBe("a9059cbb");
    expect(bytesToHex(selector("balanceOf(address)"))).toBe("70a08231");
  });

  it("encodes transfer(to, amount) as selector + two 32-byte words", () => {
    const data = erc20TransferData("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", 1_000_000n);
    expect(data.length).toBe(4 + 32 + 32);
    const h = bytesToHex(data);
    expect(h.startsWith("a9059cbb")).toBe(true);
    // Address right-aligned in the first word.
    expect(h.slice(8, 72)).toBe("0000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    // 1_000_000 = 0xf4240 right-aligned in the second word.
    expect(h.slice(72).endsWith("f4240")).toBe(true);
    expect(erc20BalanceOfData("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").length).toBe(4 + 32);
  });
});

describe("EIP-1559 transaction signing", () => {
  const tx: Eip1559Tx = {
    chainId: 137n, // Polygon
    nonce: 3n,
    maxPriorityFeePerGas: 30_000_000_000n,
    maxFeePerGas: 100_000_000_000n,
    gasLimit: 21_000n,
    to: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    value: 1_000_000_000_000_000_000n,
    data: new Uint8Array(0),
  };

  it("produces a signed type-2 tx whose signature recovers to the sender", () => {
    const priv = secp256k1.utils.randomSecretKey();
    const sender = evmAddressFromPubkey(secp256k1.getPublicKey(priv, true));

    const hash = signingHash(tx);
    expect(hash.length).toBe(32);

    // What a Signer returns: 65-byte recoverable r‖s‖v (v = recovery 0/1).
    const sig = secp256k1.sign(hash, priv);
    const sig65 = new Uint8Array(65);
    sig65.set(sig.toCompactRawBytes(), 0);
    sig65[64] = sig.recovery;

    const signed = serializeSigned(tx, sig65);
    expect(signed.raw.startsWith("0x02")).toBe(true); // typed transaction envelope
    expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/);

    const recovered = secp256k1.Signature.fromCompact(sig65.subarray(0, 64))
      .addRecoveryBit(sig65[64] as number)
      .recoverPublicKey(hash)
      .toBytes(true);
    expect(evmAddressFromPubkey(recovered)).toBe(sender);
  });

  it("is deterministic in its signing hash across identical inputs", () => {
    expect(bytesToHex(signingHash(tx))).toBe(bytesToHex(signingHash({ ...tx })));
  });
});
