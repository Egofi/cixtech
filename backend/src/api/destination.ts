import { decodeTronAddress, normalizeHexAddress } from "@/chains";
import { InvalidDestinationError, UnsupportedChainError } from "@/common";

export function assertValidDestination(
  chain: string,
  address: string,
  family: string | undefined,
): void {
  const c = chain.toUpperCase();
  try {
    if (family === "TRON") {
      const payload = decodeTronAddress(address);
      if (payload.length !== 21) throw new Error("wrong payload length");
      return;
    }
    if (family === "EVM") {
      normalizeHexAddress(address);
      return;
    }
  } catch {
    throw new InvalidDestinationError(`${address} is not a valid ${c} address`, {
      context: { chain: c, family },
      exposable: true,
    });
  }

  throw new UnsupportedChainError(`No address validator for chain ${c}`, {
    context: { chain: c, family },
  });
}
