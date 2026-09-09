import type { Eip1559Tx, RlpInput, SignedTx } from "@/types";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import { normalizeHexAddress } from "./address.js";
import { rlpEncode } from "./rlp.js";

const TX_TYPE = 0x02;

function addressBytes(to: string): Uint8Array {
  return Uint8Array.from(Buffer.from(normalizeHexAddress(to), "hex"));
}

function fields(tx: Eip1559Tx): RlpInput[] {
  return [
    tx.chainId,
    tx.nonce,
    tx.maxPriorityFeePerGas,
    tx.maxFeePerGas,
    tx.gasLimit,
    addressBytes(tx.to),
    tx.value,
    tx.data,
    [], // empty accessList
  ];
}

export function signingHash(tx: Eip1559Tx): Uint8Array {
  return keccak_256(concatBytes(Uint8Array.of(TX_TYPE), rlpEncode(fields(tx))));
}

function toBigInt(bytes: Uint8Array): bigint {
  const h = bytesToHex(bytes);
  return h === "" ? 0n : BigInt(`0x${h}`);
}

export function serializeSigned(tx: Eip1559Tx, signature: Uint8Array): SignedTx {
  if (signature.length !== 65) throw new Error("expected a 65-byte recoverable signature");
  const r = toBigInt(signature.subarray(0, 32));
  const s = toBigInt(signature.subarray(32, 64));
  const yParity = BigInt(signature[64] as number);
  const signed = rlpEncode([...fields(tx), yParity, r, s]);
  const raw = concatBytes(Uint8Array.of(TX_TYPE), signed);
  return { raw: `0x${bytesToHex(raw)}`, hash: `0x${bytesToHex(keccak_256(raw))}` };
}
