#!/usr/bin/env node
//
// Generate a CIXTECH_ENGINE_XPRV for local development and testnet.
//
// The engine refuses to boot without this variable, and until now nothing in the
// repository produced one: the README pointed at `pnpm generate-test-key`, which
// issues a tenant API key and never touches a key derivation path.
//
// NOT A PRODUCTION KEY CEREMONY. ADR 0007 and spec 16.5 are explicit that
// production keys come from a witnessed DKG producing HSM-sealed shares, and that
// testnet and mainnet run as separate deployments with separate key domains. A key
// printed to a terminal by a dev script has been seen by that terminal, its
// scrollback, and anything reading it. Use this for CHAIN_ENV=testnet only.

import { randomBytes } from "node:crypto";
import { HDKey } from "@scure/bip32";

const SEED_BYTES = 64; // BIP32 allows 16-64; 64 is the maximum entropy it will take.

const seed = randomBytes(SEED_BYTES);
const master = HDKey.fromMasterSeed(seed);

if (!master.privateExtendedKey) {
  console.error("Failed to derive an extended private key.");
  process.exit(1);
}

// What the engine does with this: `buildRouter` loads it as an account-level node
// and `KeypairSigner.child(i)` derives `0/i` from it for every pool address, on
// every chain. One key, many encodings -- Tron and the EVM family all hash the
// same secp256k1 public key (ADR 0016).
const firstChild = master.deriveChild(0).deriveChild(0);

const bold = (s) => `[1m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;

console.log(`\n${bold("CIXTECH_ENGINE_XPRV")}`);
console.log(master.privateExtendedKey);
console.log(`\n${dim("Public (xpub), safe to share:")}`);
console.log(dim(master.publicExtendedKey ?? "n/a"));
console.log(`\n${dim("First pool address key at 0/0 derives from:")}`);
console.log(
  dim(`  pubkey ${Buffer.from(firstChild.publicKey ?? new Uint8Array()).toString("hex")}`),
);

console.log(`\n${red("Testnet and local development only.")}`);
console.log("  Copy the xprv into backend/.env. Anything that reads it controls every");
console.log("  address derived from it. Production keys are a witnessed DKG ceremony");
console.log("  producing HSM-sealed shares (ADR 0007), never a value from a script.\n");
