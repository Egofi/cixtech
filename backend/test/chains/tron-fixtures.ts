import { createHash } from "node:crypto";

const varint = (n: bigint): Uint8Array => {
  const out: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
};
const tag = (no: number, wire: number) => varint((BigInt(no) << 3n) | BigInt(wire));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const lenField = (no: number, payload: Uint8Array) =>
  cat(tag(no, 2), varint(BigInt(payload.length)), payload);
const varField = (no: number, value: bigint) => cat(tag(no, 0), varint(value));
const bytesOf = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

export const trc20Calldata = (toHex21: string, amount: bigint): string =>
  `a9059cbb${toHex21.replace(/^0x/, "").slice(2).padStart(64, "0")}${amount
    .toString(16)
    .padStart(64, "0")}`;

export function trc20RawData(
  ownerHex: string,
  contractHex: string,
  calldataHex: string,
  callValue = 0n,
): string {
  const trigger = cat(
    lenField(1, bytesOf(ownerHex)),
    lenField(2, bytesOf(contractHex)),
    ...(callValue > 0n ? [varField(3, callValue)] : []),
    lenField(4, bytesOf(calldataHex)),
  );
  const any = cat(
    lenField(1, Buffer.from("type.googleapis.com/protocol.TriggerSmartContract")),
    lenField(2, trigger),
  );
  return Buffer.from(
    cat(lenField(1, bytesOf("0000")), lenField(11, cat(varField(1, 31n), lenField(2, any)))),
  ).toString("hex");
}

export function trxRawData(ownerHex: string, toHex: string, amount: bigint): string {
  const transfer = cat(
    lenField(1, bytesOf(ownerHex)),
    lenField(2, bytesOf(toHex)),
    varField(3, amount),
  );
  const any = cat(
    lenField(1, Buffer.from("type.googleapis.com/protocol.TransferContract")),
    lenField(2, transfer),
  );
  return Buffer.from(
    cat(lenField(1, bytesOf("0000")), lenField(11, cat(varField(1, 1n), lenField(2, any)))),
  ).toString("hex");
}

export const txIdFor = (rawHex: string): string =>
  createHash("sha256").update(Buffer.from(rawHex, "hex")).digest("hex");

export const builtTx = (rawHex: string) => ({ txID: txIdFor(rawHex), raw_data_hex: rawHex });
