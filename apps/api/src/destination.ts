import { UnsupportedChainError, decodeTronAddress, normalizeHexAddress } from "@cixtech/chains";
import { AppError } from "@cixtech/errors";

/** The destination is not a well-formed address on the chain it was given for. */
export class InvalidDestinationError extends AppError {
  readonly code = "INVALID_DESTINATION";
}

/**
 * Validate a destination address against the encoder for its chain, at the point
 * the tenant supplies it.
 *
 * The only checks were `minLength: 25, maxLength: 64`. A malformed or
 * wrong-chain address was therefore accepted by the allow-list, accepted by the
 * withdrawal endpoint, and only rejected deep inside the broadcaster when it came
 * to encode the transfer — by which time the payout had taken the gather lease and
 * locked funds in the ledger. It failed safe, but it failed late and noisily, and
 * a tenant got a 500-shaped failure for what is plainly a bad request.
 *
 * Same encoders the broadcasters use, so "valid here" and "encodable there" cannot
 * drift apart.
 */
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
  // An unrecognised family means we cannot vouch for the address; say so rather
  // than waving it through.
  throw new UnsupportedChainError(`No address validator for chain ${c}`, {
    context: { chain: c, family },
  });
}
