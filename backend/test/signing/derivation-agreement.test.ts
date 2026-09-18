import { deriveEvmAddress, evmAddressFromPubkey } from "@/chains/evm/address.js";
import { deriveTronAddress, tronAddressFromPubkey } from "@/chains/tron/address.js";
import { KeypairSigner } from "@/signing";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";

/**
 * The xpub deriver and the signer must agree on what lives at an index.
 *
 * Two independent code paths produce a pool or treasury address: `deriveAddress`
 * on a ChainPlugin, which walks the **xpub**, and `KeypairSigner.deriveAddress`,
 * which walks the **xprv** and is what actually signs. `pnpm derive-address`
 * prints the first so you can fund it; the engine spends with the second.
 *
 * If they ever disagreed by one derivation step you could fund a gas treasury
 * the engine cannot spend from, and the loss would be silent until a payout
 * failed for want of gas at an address that visibly holds it.
 */
const SEED = Uint8Array.from(Buffer.alloc(64, 7));
const master = HDKey.fromMasterSeed(SEED);
const XPRV = master.privateExtendedKey;
const XPUB = master.publicExtendedKey;

const INDICES = [0, 1, 7, 1_000, 1_000_000, 2_147_483_646];

describe("the xpub deriver and the signer agree at every index", () => {
  it("matches on Tron", () => {
    const signer = new KeypairSigner(XPRV, tronAddressFromPubkey);
    for (const i of INDICES) {
      expect(deriveTronAddress(XPUB, i), `tron index ${i}`).toBe(signer.deriveAddress(i));
    }
  });

  it("matches on EVM", () => {
    const signer = new KeypairSigner(XPRV, evmAddressFromPubkey);
    for (const i of INDICES) {
      expect(deriveEvmAddress(XPUB, i), `evm index ${i}`).toBe(signer.deriveAddress(i));
    }
  });

  it("gives the two families different addresses from the same key", () => {
    // Why CIXTECH_GAS_TREASURY_ADDRESS cannot be one value across families.
    expect(deriveTronAddress(XPUB, 1_000_000)).not.toBe(deriveEvmAddress(XPUB, 1_000_000));
    expect(deriveTronAddress(XPUB, 1_000_000).startsWith("T")).toBe(true);
    expect(deriveEvmAddress(XPUB, 1_000_000).startsWith("0x")).toBe(true);
  });

  it("gives every index a distinct address", () => {
    const seen = new Set(INDICES.map((i) => deriveEvmAddress(XPUB, i)));
    expect(seen.size).toBe(INDICES.length);
  });
});
