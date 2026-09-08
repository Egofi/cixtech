import { AppError } from "@/errors";
import { secp256k1 } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import type { Signer } from "./signer.js";

/** Encodes a secp256k1 public key into a chain-specific address (injected, so this
 * package stays chain-agnostic — e.g. Tron's 0x41 base58check). */
export type PubkeyToAddress = (pubkey: Uint8Array) => string;

export class SigningKeyUnavailableError extends AppError {
  readonly code = "SIGNING_KEY_UNAVAILABLE";
}

/**
 * Keypair signer (ADR 0007 launch path). Holds an account-level extended PRIVATE
 * key (xprv) and derives child keys at `0/index`; signs the 32-byte hash a chain
 * puts in front of it. The full key never leaves this object. Swapping in
 * threshold MPC later means replacing this class behind the `Signer` port —
 * nothing else changes.
 *
 * In production the xprv lives only inside the signer's trust boundary (HSM /
 * MPC domain), never on an app server.
 */
export class KeypairSigner implements Signer {
  private readonly account: HDKey;

  constructor(
    accountXprv: string,
    private readonly encodeAddress: PubkeyToAddress,
  ) {
    this.account = HDKey.fromExtendedKey(accountXprv.trim());
    if (!this.account.privateKey) {
      throw new SigningKeyUnavailableError("KeypairSigner requires an extended PRIVATE key (xprv)");
    }
  }

  private child(index: number): HDKey {
    if (!Number.isInteger(index) || index < 0) {
      throw new SigningKeyUnavailableError(
        `Derivation index must be a non-negative integer: ${index}`,
      );
    }
    return this.account.deriveChild(0).deriveChild(index);
  }

  deriveAddress(index: number): string {
    const pub = this.child(index).publicKey;
    if (!pub) throw new SigningKeyUnavailableError(`No public key at index ${index}`);
    return this.encodeAddress(pub);
  }

  signHash(index: number, hash: Uint8Array): Uint8Array {
    if (hash.length !== 32) throw new SigningKeyUnavailableError("hash must be 32 bytes");
    const priv = this.child(index).privateKey;
    if (!priv) throw new SigningKeyUnavailableError(`No private key at index ${index}`);

    const sig = secp256k1.sign(hash, priv); // low-S, with recovery
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0); // r ‖ s
    out[64] = sig.recovery; // v
    return out;
  }
}
