import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import { normalizeHexAddress } from "./address.js";
import { type RlpInput, rlpEncode } from "./rlp.js";

/** An unsigned EIP-1559 (type 0x02) transaction. Access list is always empty here. */
export interface Eip1559Tx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** 0x-address; empty string is not allowed (no contract-creation payouts). */
  to: string;
  value: bigint;
  data: Uint8Array;
}

const TX_TYPE = 0x02;

function addressBytes(to: string): Uint8Array {
  return Uint8Array.from(Buffer.from(normalizeHexAddress(to), "hex"));
}

/** The nine transaction fields, in canonical order, as RLP inputs. */
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

/** The 32-byte hash to sign: keccak256(0x02 ‖ rlp(fields)). */
export function signingHash(tx: Eip1559Tx): Uint8Array {
  return keccak_256(concatBytes(Uint8Array.of(TX_TYPE), rlpEncode(fields(tx))));
}

/** A minimal-big-endian bigint from a fixed-width byte slice (for r/s). */
function toBigInt(bytes: Uint8Array): bigint {
  const h = bytesToHex(bytes);
  return h === "" ? 0n : BigInt(`0x${h}`);
}

export interface SignedTx {
  /** 0x-prefixed raw transaction for eth_sendRawTransaction. */
  raw: string;
  /** 0x-prefixed transaction hash (keccak256 of the raw bytes). */
  hash: string;
}

/**
 * Assemble a signed type-0x02 transaction from the 65-byte recoverable signature
 * the `Signer` port returns (r‖s‖v, v = 0/1 recovery = EIP-1559 yParity). r and s
 * are RLP-encoded as minimal big-endian integers; the signed tx is
 * 0x02 ‖ rlp([...fields, yParity, r, s]).
 */
export function serializeSigned(tx: Eip1559Tx, signature: Uint8Array): SignedTx {
  if (signature.length !== 65) throw new Error("expected a 65-byte recoverable signature");
  const r = toBigInt(signature.subarray(0, 32));
  const s = toBigInt(signature.subarray(32, 64));
  const yParity = BigInt(signature[64] as number);
  const signed = rlpEncode([...fields(tx), yParity, r, s]);
  const raw = concatBytes(Uint8Array.of(TX_TYPE), signed);
  return { raw: `0x${bytesToHex(raw)}`, hash: `0x${bytesToHex(keccak_256(raw))}` };
}
