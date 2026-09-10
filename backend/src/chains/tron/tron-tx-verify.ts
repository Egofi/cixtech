import { TronTxMismatchError } from "@/common";
import type { TronTransferIntent } from "@/types";
import { sha256 } from "@noble/hashes/sha2";

const CONTRACT_TYPE_TRANSFER = 1;
const CONTRACT_TYPE_TRIGGER_SMART_CONTRACT = 31;

const TRANSFER_SELECTOR = "a9059cbb";

interface Field {
  no: number;
  wire: number;

  bytes?: Uint8Array;

  value?: bigint;
}

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

interface DecodedTransfer {
  type: number;
  ownerHex: string;

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

  if (data.length !== 136 || !data.startsWith(TRANSFER_SELECTOR)) {
    throw new TronTxMismatchError(
      "Node returned a contract call that is not a plain TRC20 transfer(address,uint256)",
      { context: { selector: data.slice(0, 8), calldataBytes: data.length / 2 } },
    );
  }

  if (callValue !== 0n) {
    throw new TronTxMismatchError("Node returned a TRC20 transfer carrying non-zero call_value", {
      context: { callValue: callValue.toString() },
    });
  }

  const addrWord = data.slice(8, 72);
  if (!/^0{24}[0-9a-f]{40}$/.test(addrWord)) {
    throw new TronTxMismatchError("TRC20 recipient word is not a right-aligned 20-byte address");
  }
  return {
    type: CONTRACT_TYPE_TRIGGER_SMART_CONTRACT,
    ownerHex,

    toHex: `41${addrWord.slice(24)}`,
    amount: BigInt(`0x${data.slice(72)}`),
    contractHex,
  };
}

export function decodeTronRawData(rawDataHex: string): DecodedTransfer {
  const clean = rawDataHex.replace(/^0x/, "");
  if (clean.length === 0 || !/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new TronTxMismatchError("Node returned no usable raw_data_hex to verify");
  }
  const raw = Uint8Array.from(Buffer.from(clean, "hex"));

  const contracts = readFields(raw).filter((f) => f.no === 11 && f.bytes);
  if (contracts.length !== 1) {
    throw new TronTxMismatchError(
      `A payout transaction must carry exactly one contract, got ${contracts.length}`,
      { context: { contracts: contracts.length } },
    );
  }

  const c = readFields((contracts[0] as Field).bytes as Uint8Array);
  const type = Number(field(c, 1)?.value ?? 0n);

  const anyFields = readFields(field(c, 2)?.bytes ?? new Uint8Array(0));
  const value = field(anyFields, 2)?.bytes;
  if (!value) throw new TronTxMismatchError("Contract parameter carries no value");

  if (type === CONTRACT_TYPE_TRANSFER) return decodeTransferContract(value);
  if (type === CONTRACT_TYPE_TRIGGER_SMART_CONTRACT) return decodeTriggerSmartContract(value);
  throw new TronTxMismatchError(`Refusing to sign Tron contract type ${type}`, {
    context: { type },
  });
}

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
