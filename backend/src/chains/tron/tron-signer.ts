import { KeypairSigner, type Signer } from "@/signing";
import { tronAddressFromPubkey } from "./address.js";

export function makeTronSigner(accountXprv: string): KeypairSigner {
  return new KeypairSigner(accountXprv, tronAddressFromPubkey);
}

export function signTronTxId(signer: Signer, index: number, txIdHex: string): string {
  const hash = Uint8Array.from(Buffer.from(txIdHex.replace(/^0x/, ""), "hex"));
  return Buffer.from(signer.signHash(index, hash)).toString("hex");
}
