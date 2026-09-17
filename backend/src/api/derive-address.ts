import { deriveEvmAddress } from "@/chains/evm/address.js";
import { deriveTronAddress } from "@/chains/tron/address.js";
/**
 * Print the address the engine derives from `CIXTECH_ENGINE_XPRV` at a given
 * index, per chain family.
 *
 *   pnpm derive-address 1000000
 *
 * This is how you get `CIXTECH_GAS_TREASURY_ADDRESS`: the gas treasury is not a
 * separate wallet you create somewhere, it is one of *this engine's own*
 * addresses. `BroadcasterGasFunder` sends native gas from it by calling
 * `signer.signHash(CIXTECH_GAS_TREASURY_INDEX, ...)`, and the signer derives
 * `0/index` from the engine key -- so the address and the index have to be the
 * same address, or the engine signs for one address while the chain is told the
 * funds come from another.
 *
 * It deliberately uses the same `deriveTronAddress` / `deriveEvmAddress` the
 * router registers, rather than re-implementing the encoding here. A second
 * implementation that disagreed by one byte would print an address you could
 * fund and the engine could never spend from.
 */
import { HDKey } from "@scure/bip32";

// Pool addresses are allocated `MAX(derivation_index) + 1` per chain, starting at
// 0, so low indices WILL be handed out to merchants as deposit addresses. Sharing
// one with the gas treasury would mean gas top-ups funding a customer's deposit
// address, and `UNIQUE (chain, address)` failing the pool insert when allocation
// reaches it. Start high enough that allocation never arrives.
const SUGGESTED_FLOOR = 1_000_000;

function main(): number {
  const xprv = process.env["CIXTECH_ENGINE_XPRV"];
  if (!xprv || xprv === "REPLACE_ME") {
    console.error(
      "CIXTECH_ENGINE_XPRV is not set. Generate one with `make key` first.\n" +
        "The address printed here is derived from it, so it changes if the key changes.",
    );
    return 1;
  }

  const raw = process.argv.find((a) => /^\d+$/.test(a));
  if (raw === undefined) {
    console.error("Usage: pnpm derive-address <index>   e.g. pnpm derive-address 1000000");
    return 1;
  }
  const index = Number(raw);
  if (!Number.isSafeInteger(index) || index < 0) {
    console.error(`Index must be a non-negative integer, got ${raw}`);
    return 1;
  }

  let xpub: string;
  try {
    xpub = HDKey.fromExtendedKey(xprv.trim()).publicExtendedKey;
  } catch {
    console.error("CIXTECH_ENGINE_XPRV is not a valid extended key. Regenerate with `make key`.");
    return 1;
  }

  const bold = (s: string) => `[1m${s}[0m`;
  const dim = (s: string) => `[2m${s}[0m`;
  const yellow = (s: string) => `[33m${s}[0m`;

  console.log(
    `\n${bold(`Addresses at derivation index ${index}`)}  ${dim("(path 0/" + index + ")")}\n`,
  );
  console.log(`  ${bold("TRON")}          ${deriveTronAddress(xpub, index)}`);
  console.log(`  ${bold("EVM")}           ${deriveEvmAddress(xpub, index)}`);
  console.log(
    dim("                every EVM chain shares one address -- same key, same encoding\n"),
  );

  if (index < SUGGESTED_FLOOR) {
    console.log(
      yellow(`  Warning: index ${index} is below ${SUGGESTED_FLOOR.toLocaleString()}.`) +
        "\n  Pool deposit addresses are allocated from 0 upward per chain, so this index\n" +
        "  can later be handed to a merchant. Prefer something allocation will not reach.\n",
    );
  }

  console.log(`${bold("To use as the gas treasury")}, in backend/.env:\n`);
  console.log(`  CIXTECH_GAS_TREASURY_INDEX=${index}`);
  console.log(`  CIXTECH_GAS_TREASURY_ADDRESS_TRON=${deriveTronAddress(xpub, index)}`);
  console.log(`  CIXTECH_GAS_TREASURY_ADDRESS_POLYGON=${deriveEvmAddress(xpub, index)}`);
  console.log(dim("  ...one line per chain you run; see .env.example\n"));
  console.log("Then send that address native gas (TRX / POL / ETH) from a faucet or\n");
  console.log("an exchange. It pays the fee for every token payout on that chain.\n");
  return 0;
}

process.exit(main());
