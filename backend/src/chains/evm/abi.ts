import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { normalizeHexAddress } from "./address.js";
import { toMinimalBytes } from "./rlp.js";

export function selector(signature: string): Uint8Array {
  return keccak_256(utf8ToBytes(signature)).subarray(0, 4);
}

function word(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("ABI word overflow");
  const w = new Uint8Array(32);
  w.set(bytes, 32 - bytes.length);
  return w;
}

const TRANSFER = selector("transfer(address,uint256)");
const BALANCE_OF = selector("balanceOf(address)");

export function erc20TransferData(to: string, amount: bigint): Uint8Array {
  const addr = Uint8Array.from(Buffer.from(normalizeHexAddress(to), "hex"));
  return concatBytes(TRANSFER, word(addr), word(toMinimalBytes(amount)));
}

export function erc20BalanceOfData(owner: string): Uint8Array {
  const addr = Uint8Array.from(Buffer.from(normalizeHexAddress(owner), "hex"));
  return concatBytes(BALANCE_OF, word(addr));
}

export const TRANSFER_EVENT_TOPIC = `0x${Buffer.from(
  keccak_256(utf8ToBytes("Transfer(address,address,uint256)")),
).toString("hex")}`;
