import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { normalizeHexAddress } from "./address.js";
import { toMinimalBytes } from "./rlp.js";

/** The 4-byte selector for a Solidity function signature (keccak256(sig)[:4]). */
export function selector(signature: string): Uint8Array {
  return keccak_256(utf8ToBytes(signature)).subarray(0, 4);
}

/** Left-pad bytes to a 32-byte ABI word. */
function word(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("ABI word overflow");
  const w = new Uint8Array(32);
  w.set(bytes, 32 - bytes.length);
  return w;
}

const TRANSFER = selector("transfer(address,uint256)");
const BALANCE_OF = selector("balanceOf(address)");

/** Calldata for ERC20 `transfer(to, amount)`. */
export function erc20TransferData(to: string, amount: bigint): Uint8Array {
  const addr = Uint8Array.from(Buffer.from(normalizeHexAddress(to), "hex"));
  return concatBytes(TRANSFER, word(addr), word(toMinimalBytes(amount)));
}

/** Calldata for ERC20 `balanceOf(owner)`. */
export function erc20BalanceOfData(owner: string): Uint8Array {
  const addr = Uint8Array.from(Buffer.from(normalizeHexAddress(owner), "hex"));
  return concatBytes(BALANCE_OF, word(addr));
}

/** keccak256 topic for the ERC20 `Transfer(address,address,uint256)` event. */
export const TRANSFER_EVENT_TOPIC = `0x${Buffer.from(
  keccak_256(utf8ToBytes("Transfer(address,address,uint256)")),
).toString("hex")}`;
