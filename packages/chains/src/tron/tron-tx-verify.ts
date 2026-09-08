import { AppError } from "@cixtech/errors";
import { sha256 } from "@noble/hashes/sha2";

/**
 * Independent verification of a transaction a Tron node built for us, before we
 * sign it (build spec §7, ADR 0007's "the last mile verifies what it can evaluate
 * independently").
 *
 * The engine does not protobuf-encode Tron transactions itself; it asks the node
 * to build one. That is a reasonable simplification RIGHT UP UNTIL the point of
 * signing, because the thing being signed is `sha256(raw_data)` — so trusting the
 * node's `txID` means signing whatever the node decided to put in `raw_data`. A
 * hostile or compromised endpoint returns a transfer of the whole balance to its
 * own address with a perfectly self-consistent `txID`, and an engine that signs
 * the returned hash produces a valid signature over a payout it never authorized.
 *
 * So we re-derive the hash from the serialized bytes and decode those bytes to
 * check the transfer against the intent. Two properties matter and they are
 * separate:
 *
 *  1. `sha256(raw_data_hex) == txID` — the hash we are about to sign really is
 *     the hash of these bytes, so the decode below describes what we sign.
 *  2. The decoded contract matches the intent — owner, recipient, amount, and for
 *     TRC-20 the token contract and the exact `transfer(address,uint256)`
 *     calldata.
 *
 * Checking the node's `raw_data` JSON instead would be theatre: the JSON is not
 * what gets hashed. `raw_data_hex` is, so that is what we decode.
 *
 * The EVM broadcaster reaches the same guarantee by building the transaction
 * locally and refusing a hash the node disagrees with; this is the equivalent for
 * a chain where the node does the encoding.
 */

/** The node returned a transaction that does not match what the engine asked it to build. */
export class TronTxMismatchError extends AppError {
  readonly code = "TRON_TX_MISMATCH";
}

/** Tron contract type ids (Transaction.Contract.ContractType). */
const CONTRACT_TYPE_TRANSFER = 1; // TransferContract — native TRX
const CONTRACT_TYPE_TRIGGER_SMART_CONTRACT = 31; // TriggerSmartContract — TRC20 & friends

/** ERC20/TRC20 `transfer(address,uint256)` selector. */
const TRANSFER_SELECTOR = "a9059cbb";

interface Field {
  no: number;
  wire: number;
  /** Wire type 2 payload, or undefined for a varint/fixed field. */
  bytes?: Uint8Array;
  /** Varint / fixed value. */
  value?: bigint;
}

/**
 * Minimal protobuf wire-format reader — enough to walk `Transaction.raw` and the
 * one contract inside it. Deliberately hand-rolled and tiny rather than pulling a
 * protobuf runtime: the whole point of this module is that it is auditable, and a
 * verifier you cannot read is not a verifier.
 */
function readFields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let shift = 0n;
    let result = 0n;
    for (;;) {
      if (i >= buf.length) throw new TronTxMismatchError("Truncated protobuf varint");
      const b = buf[i++] as number;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new TronTxMismatchError("Overlong protobuf varint");
    }
  };
  while (i < buf.length) {
    const key = varint();
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      out.push({ no, wire, value: varint() });
    } else if (wire === 2) {
      const len = Number(varint());
      if (len < 0 || i + len > buf.length) {
        throw new TronTxMismatchError("Truncated protobuf length-delimited field");
      }
      out.push({ no, wire, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      i += 4;
      out.push({ no, wire });
    } else if (wire === 1) {
      i += 8;
      out.push({ no, wire });
    } else {
      throw new TronTxMismatchError(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return out;
}

const field = (fields: Field[], no: number): Field | undefined => fields.find((f) => f.no === no);
const hex = (b: Uint8Array | undefined): string =>
  b ? Buffer.from(b).toString("hex").toLowerCase() : "";

/** What the engine asked the node to build — the intent the decoded bytes must match. */
export interface TronTransferIntent {
  /** Hex, 0x41-prefixed 21 bytes: the pool address the funds leave. */
  ownerHex: string;
  /** Hex, 0x41-prefixed 21 bytes: the payout destination. */
  toHex: string;
  amountBaseUnits: bigint;
  /** Hex, 0x41-prefixed 21 bytes. Present for TRC20, absent for native TRX. */
  contractHex?: string | undefined;
}

/** The decoded contract, in the shape the intent is compared against. */
interface DecodedTransfer {
  type: number;
  ownerHex: string;
  /** Recipient — from `to_address` for TRX, or the calldata's address word for TRC20. */
  toHex: string;
  amount: bigint;
  contractHex?: string;
}

function decodeTransferContract(value: Uint8Array): DecodedTransfer {
  const f = readFields(value);
  return {
    type: CONTRACT_TYPE_TRANSFER,
    ownerHex: hex(field(f, 1)?.bytes),
    toHex: hex(field(f, 2)?.bytes),
    amount: field(f, 3)?.value ?? 0n,
  };
}

function decodeTriggerSmartContract(value: Uint8Array): DecodedTransfer {
  const f = readFields(value);
  const ownerHex = hex(field(f, 1)?.bytes);
  const contractHex = hex(field(f, 2)?.bytes);
  const callValue = field(f, 3)?.value ?? 0n;
  const data = hex(field(f, 4)?.bytes);

  // A payout must be a plain `transfer(address,uint256)` and nothing else: the
  // selector fixes the method, and the 68-byte length fixes the argument count,
  // so a node cannot append arguments or hand us a different method that happens
  // to start with the same four bytes.
  if (data.length !== 136 || !data.startsWith(TRANSFER_SELECTOR)) {
    throw new TronTxMismatchError(
      "Node returned a contract call that is not a plain TRC20 transfer(address,uint256)",
      { context: { selector: data.slice(0, 8), calldataBytes: data.length / 2 } },
    );
  }
  // A TRC20 transfer moves no TRX; a non-zero call_value would drain native gas
  // alongside the token.
  if (callValue !== 0n) {
    throw new TronTxMismatchError("Node returned a TRC20 transfer carrying non-zero call_value", {
      context: { callValue: callValue.toString() },
    });
  }

  const addrWord = data.slice(8, 72); // 32-byte word, address right-aligned
  if (!/^0{24}[0-9a-f]{40}$/.test(addrWord)) {
    throw new TronTxMismatchError("TRC20 recipient word is not a right-aligned 20-byte address");
  }
  return {
    type: CONTRACT_TYPE_TRIGGER_SMART_CONTRACT,
    ownerHex,
    // Re-add the 0x41 prefix so it compares against the engine's address form.
    toHex: `41${addrWord.slice(24)}`,
    amount: BigInt(`0x${data.slice(72)}`),
    contractHex,
  };
}

/**
 * Decode the exact bytes that will be hashed and signed, and return the transfer
 * they describe. Throws when `raw_data_hex` is absent, malformed, carries more
 * than one contract, or holds a contract type a payout never uses.
 */
export function decodeTronRawData(rawDataHex: string): DecodedTransfer {
  const clean = rawDataHex.replace(/^0x/, "");
  if (clean.length === 0 || !/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new TronTxMismatchError("Node returned no usable raw_data_hex to verify");
  }
  const raw = Uint8Array.from(Buffer.from(clean, "hex"));

  // Transaction.raw field 11 = repeated Transaction.Contract.
  const contracts = readFields(raw).filter((f) => f.no === 11 && f.bytes);
  if (contracts.length !== 1) {
    throw new TronTxMismatchError(
      `A payout transaction must carry exactly one contract, got ${contracts.length}`,
      { context: { contracts: contracts.length } },
    );
  }

  // Transaction.Contract: field 1 = type, field 2 = parameter (Any).
  const c = readFields((contracts[0] as Field).bytes as Uint8Array);
  const type = Number(field(c, 1)?.value ?? 0n);
  // google.protobuf.Any: field 1 = type_url, field 2 = value.
  const anyFields = readFields(field(c, 2)?.bytes ?? new Uint8Array(0));
  const value = field(anyFields, 2)?.bytes;
  if (!value) throw new TronTxMismatchError("Contract parameter carries no value");

  if (type === CONTRACT_TYPE_TRANSFER) return decodeTransferContract(value);
  if (type === CONTRACT_TYPE_TRIGGER_SMART_CONTRACT) return decodeTriggerSmartContract(value);
  throw new TronTxMismatchError(`Refusing to sign Tron contract type ${type}`, {
    context: { type },
  });
}

/**
 * Assert the node's transaction is the one we asked for, and return the 32-byte
 * hash to sign — re-derived from the bytes, never taken from the node's `txID`.
 *
 * Order matters: the hash is checked FIRST, because until `txID` is proven to be
 * the hash of `raw_data_hex` there is no reason to believe the bytes we decoded
 * are the bytes that get signed.
 */
export function verifiedTronSigningHash(
  tx: { txID?: string; raw_data_hex?: string },
  intent: TronTransferIntent,
): Uint8Array {
  const rawHex = (tx.raw_data_hex ?? "").replace(/^0x/, "").toLowerCase();
  const txId = (tx.txID ?? "").replace(/^0x/, "").toLowerCase();
  if (!txId) throw new TronTxMismatchError("Node returned no txID");

  const digest = sha256(Uint8Array.from(Buffer.from(rawHex, "hex")));
  const digestHex = Buffer.from(digest).toString("hex");
  if (rawHex.length === 0 || digestHex !== txId) {
    throw new TronTxMismatchError(
      "Tron txID is not the hash of the transaction body the node returned",
      { context: { txId, derived: digestHex } },
    );
  }

  const got = decodeTronRawData(rawHex);
  const want = {
    ownerHex: intent.ownerHex.replace(/^0x/, "").toLowerCase(),
    toHex: intent.toHex.replace(/^0x/, "").toLowerCase(),
    contractHex: intent.contractHex?.replace(/^0x/, "").toLowerCase(),
  };

  const mismatch = (what: string, expected: string, actual: string): never => {
    throw new TronTxMismatchError(
      `Node built a transaction with a different ${what} than the payout authorized`,
      { context: { what, expected, actual } },
    );
  };

  if (got.ownerHex !== want.ownerHex) mismatch("from-address", want.ownerHex, got.ownerHex);
  if (got.toHex !== want.toHex) mismatch("destination", want.toHex, got.toHex);
  if (got.amount !== intent.amountBaseUnits) {
    mismatch("amount", intent.amountBaseUnits.toString(), got.amount.toString());
  }
  if (want.contractHex === undefined) {
    if (got.type !== CONTRACT_TYPE_TRANSFER) {
      mismatch("contract type", "native TRX transfer", String(got.type));
    }
  } else if (got.contractHex !== want.contractHex) {
    mismatch("token contract", want.contractHex, got.contractHex ?? "");
  }

  return digest;
}
