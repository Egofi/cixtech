import { KeypairSigner, type Signer } from "@cixtech/signing";
import { tronAddressFromPubkey } from "./address.js";

/** A keypair Signer whose addresses are Tron base58check (ADR 0007 launch path). */
export function makeTronSigner(accountXprv: string): KeypairSigner {
  return new KeypairSigner(accountXprv, tronAddressFromPubkey);
}

/**
 * Sign a Tron transaction id — the hex sha256 of the transaction's raw_data that
 * the node returns from createtransaction / triggersmartcontract. Tron expects a
 * 65-byte r‖s‖v signature, hex-encoded, attached to the tx before broadcast.
 */
export function signTronTxId(signer: Signer, index: number, txIdHex: string): string {
  const hash = Uint8Array.from(Buffer.from(txIdHex.replace(/^0x/, ""), "hex"));
  return Buffer.from(signer.signHash(index, hash)).toString("hex");
}
