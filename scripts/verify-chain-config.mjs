/**
 * Check every configured chain against the chain itself.
 *
 *   node scripts/verify-chain-config.mjs        # or: make verify-chains
 *
 * Chain IDs and token contracts are the two values you cannot safely take from
 * a blog post, a search result or an address aggregator. A wrong chain ID makes
 * signatures invalid on the network you meant; a wrong token contract is worse,
 * because it fails QUIETLY — the engine credits deposits of a token it does not
 * control, or reads a real balance as zero and refuses payouts whose funds are
 * sitting in the pool address.
 *
 * So this asks the network. `eth_chainId` is authoritative for the chain id, and
 * `symbol()` / `decimals()` on the contract are authoritative for what the token
 * actually is. Get the candidate address from the ISSUER (Circle for USDC,
 * Tether for USDT) or the chain's own bridge documentation, put it in .env, and
 * run this before it ever sees value.
 *
 * Exits non-zero on any mismatch, so it can gate a deploy.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

/** Same precedence the dev runner uses: real env wins, then .env.dev, then .env. */
function loadEnv() {
  for (const file of [resolve(repoRoot, "apps/api/.env.dev"), resolve(repoRoot, ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] === undefined) {
        process.env[key] = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
      }
    }
  }
}

/** The expected shape, mirroring packages/chain-config. Kept as data, not imported,
 *  so this script runs without a build step. */
const EXPECTED = {
  testnet: {
    ETHEREUM: 11155111,
    POLYGON: 80002,
    BSC: 97,
    ARBITRUM: 421614,
    BASE: 84532,
    AVALANCHE: 43113,
    OPTIMISM: 11155420,
  },
  mainnet: {
    ETHEREUM: 1,
    POLYGON: 137,
    BSC: 56,
    ARBITRUM: 42161,
    BASE: 8453,
    AVALANCHE: 43114,
    OPTIMISM: 10,
  },
};
const EVM_TOKENS = ["USDC", "USDT"];
const EXPECTED_DECIMALS = { USDC: 6, USDT: 6 };

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

/** ERC-20 `symbol()` returns a dynamic string: [offset][length][utf8 bytes]. */
function decodeString(hex) {
  const data = hex.replace(/^0x/, "");
  if (data.length < 128) return null;
  const length = Number.parseInt(data.slice(64, 128), 16);
  if (!Number.isFinite(length) || length === 0 || length > 64) return null;
  const bytes = data.slice(128, 128 + length * 2);
  return Buffer.from(bytes, "hex").toString("utf8").replace(/\0+$/, "");
}

async function verifyEvmChain(chain, url, env, results) {
  const expectedId = EXPECTED[env]?.[chain];
  try {
    const idHex = await rpc(url, "eth_chainId");
    const actualId = Number.parseInt(idHex, 16);
    if (actualId === expectedId) {
      results.push({ ok: true, chain, what: `chain id ${actualId}` });
    } else {
      results.push({
        ok: false,
        chain,
        what: `chain id — RPC says ${actualId}, ${env} config expects ${expectedId}`,
        hint: "this RPC is pointed at a different network than the config",
      });
    }
  } catch (err) {
    results.push({ ok: false, chain, what: `unreachable — ${err.message}`, hint: url });
    return;
  }

  for (const symbol of EVM_TOKENS) {
    const address = process.env[`${chain}_${symbol}_ADDRESS`];
    if (!address) {
      results.push({
        ok: false,
        chain,
        what: `${symbol} — no ${chain}_${symbol}_ADDRESS set`,
        hint: "the engine refuses to boot without it",
      });
      continue;
    }
    try {
      // symbol() = 0x95d89b41, decimals() = 0x313ce567
      const [symHex, decHex] = await Promise.all([
        rpc(url, "eth_call", [{ to: address, data: "0x95d89b41" }, "latest"]),
        rpc(url, "eth_call", [{ to: address, data: "0x313ce567" }, "latest"]),
      ]);
      const onChainSymbol = decodeString(symHex);
      const onChainDecimals = Number.parseInt(decHex, 16);
      const expectedDecimals = EXPECTED_DECIMALS[symbol];

      if (onChainSymbol === null && (symHex === "0x" || !symHex)) {
        results.push({
          ok: false,
          chain,
          what: `${symbol} — nothing deployed at ${address}`,
          hint: "wrong network, or a typo in the address",
        });
        continue;
      }
      const symbolOk = onChainSymbol?.toUpperCase().includes(symbol);
      const decimalsOk = onChainDecimals === expectedDecimals;
      if (symbolOk && decimalsOk) {
        results.push({
          ok: true,
          chain,
          what: `${symbol} → ${onChainSymbol} (${onChainDecimals}dp)`,
        });
      } else {
        results.push({
          ok: false,
          chain,
          what: `${symbol} — contract reports ${onChainSymbol ?? "?"} (${onChainDecimals}dp), expected ${symbol} (${expectedDecimals}dp)`,
          hint: "this address is not the token you think it is",
        });
      }
    } catch (err) {
      results.push({
        ok: false,
        chain,
        what: `${symbol} — call failed: ${err.message}`,
        hint: address,
      });
    }
  }
}

async function verifyTron(url, results) {
  try {
    const res = await fetch(`${url}/wallet/getnowblock`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const block = await res.json();
    const height = block?.block_header?.raw_data?.number;
    results.push({
      ok: Boolean(height),
      chain: "TRON",
      what: `reachable at block ${height ?? "?"}`,
    });
  } catch (err) {
    results.push({ ok: false, chain: "TRON", what: `unreachable — ${err.message}`, hint: url });
    return;
  }
  const address = process.env["TRON_USDT_ADDRESS"];
  if (!address) {
    results.push({
      ok: false,
      chain: "TRON",
      what: "USDT — no TRON_USDT_ADDRESS set",
      hint: "the engine refuses to boot without it",
    });
    return;
  }
  try {
    const res = await fetch(`${url}/wallet/getcontract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: address, visible: true }),
    });
    const contract = await res.json();
    if (contract?.contract_address || contract?.bytecode) {
      results.push({ ok: true, chain: "TRON", what: `USDT contract exists at ${address}` });
    } else {
      results.push({
        ok: false,
        chain: "TRON",
        what: `USDT — no contract at ${address}`,
        hint: "wrong network (Nile vs mainnet), or a typo",
      });
    }
  } catch (err) {
    results.push({ ok: false, chain: "TRON", what: `USDT — lookup failed: ${err.message}` });
  }
}

async function main() {
  loadEnv();
  const env = process.env["CHAIN_ENV"];
  if (env !== "testnet" && env !== "mainnet") {
    const why =
      "Without it there is no way to know which network the addresses below should belong to.";
    console.error(
      `${C.red}CHAIN_ENV must be 'testnet' or 'mainnet' — got ${env ?? "unset"}.${C.reset}\n${why}`,
    );
    process.exit(1);
  }

  console.log(`\n${C.bold}Verifying chain configuration against the chains themselves${C.reset}`);
  console.log(`${C.dim}CHAIN_ENV=${env}${C.reset}\n`);

  const results = [];
  const unconfigured = [];

  const tronUrl = process.env["TRON_RPC_URL"];
  if (tronUrl) await verifyTron(tronUrl, results);
  else unconfigured.push("TRON");

  for (const chain of Object.keys(EXPECTED[env])) {
    const url = process.env[`${chain}_RPC_URL`];
    if (!url) {
      unconfigured.push(chain);
      continue;
    }
    await verifyEvmChain(chain, url, env, results);
  }

  let current = null;
  for (const r of results) {
    if (r.chain !== current) {
      console.log(`  ${C.bold}${r.chain}${C.reset}`);
      current = r.chain;
    }
    const mark = r.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`    ${mark} ${r.what}`);
    if (!r.ok && r.hint) console.log(`      ${C.dim}${r.hint}${C.reset}`);
  }

  if (unconfigured.length > 0) {
    console.log(`\n  ${C.dim}Not configured (no RPC URL): ${unconfigured.join(", ")}${C.reset}`);
  }

  const failures = results.filter((r) => !r.ok).length;
  if (results.length === 0) {
    console.log(`\n${C.yellow}No chains configured.${C.reset} Set at least one <CHAIN>_RPC_URL.\n`);
    process.exit(1);
  }
  if (failures > 0) {
    const consequence =
      "The engine will refuse to boot on a missing token address, and a mismatched one would be believed. Fix these before this config sees value.";
    console.log(`\n${C.red}${failures} problem(s).${C.reset} ${consequence}\n`);
    process.exit(1);
  }
  console.log(`\n${C.green}All configured chains verified against their networks.${C.reset}\n`);
}

main().catch((err) => {
  console.error(`${C.red}${err.stack ?? err.message}${C.reset}`);
  process.exit(1);
});
