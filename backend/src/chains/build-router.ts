import { ChainRegistry } from "@/chain-config";
import { ChainMisconfiguredError, InvalidEnvError } from "@/common";
import type { SkippedChain, SqlClient } from "@/types";

import { HDKey } from "@scure/bip32";
import { ChainRouter } from "./chain-router.js";
import { deriveEvmAddress } from "./evm/address.js";
import { EvmAdapter } from "./evm/evm-adapter.js";
import { EvmBalanceProvider } from "./evm/evm-balance.js";
import { EvmPayoutBroadcaster } from "./evm/evm-broadcaster.js";
import { EvmDepositSource } from "./evm/evm-deposit-source.js";
import { EvmRpc } from "./evm/evm-rpc.js";
import { FetchHttpClient } from "./http.js";
import { DepositCursorStore } from "./ingest/deposit-cursor.js";
import { TronPayoutBroadcaster } from "./payout/tron-broadcaster.js";
import { deriveTronAddress } from "./tron/address.js";
import { TronAdapter } from "./tron/tron-adapter.js";
import { TronBalanceProvider } from "./tron/tron-balance.js";
import { makeTronSigner } from "./tron/tron-signer.js";

const TRON_SOLIDIFIED_CONFIRMATIONS = 19;
const TRON_FEE_LIMIT_SUN = 100_000_000;
const DEFAULT_EVM_LOOKBACK_BLOCKS = 5_000;
const EVM_CHAINS = [
  "POLYGON",
  "BSC",
  "ARBITRUM",
  "BASE",
  "ETHEREUM",
  "AVALANCHE",
  "OPTIMISM",
] as const;
const NATIVE_SYMBOL: Record<string, string> = {
  POLYGON: "POL",
  BSC: "BNB",
  ARBITRUM: "ETH",
  BASE: "ETH",
  ETHEREUM: "ETH",
  AVALANCHE: "AVAX",
  OPTIMISM: "ETH",
};

type Env = Record<string, string | undefined>;

function resolveTokenContracts(
  registry: ChainRegistry,
  env: Env,
  chain: string,
): Record<string, string> {
  const contracts: Record<string, string> = {};
  const missing: string[] = [];
  for (const token of registry.tokens(chain)) {
    if (token.native) continue;
    const address = env[token.contractAddressEnvVar];
    if (address) contracts[token.symbol] = address;
    else missing.push(`${token.symbol} (${token.contractAddressEnvVar})`);
  }
  if (missing.length > 0) {
    const remedy =
      "Set them, or remove the RPC URL to leave the chain unregistered — an unresolved token reads as a zero balance and silently blocks payouts.";
    throw new ChainMisconfiguredError(
      `${chain} has an RPC URL but no contract address for ${missing.join(", ")}. ${remedy}`,
      { context: { chain, missing: missing.join(",") } },
    );
  }
  return contracts;
}

export interface BuiltRouter {
  router: ChainRouter;
  engineXpub: string;

  chains: string[];

  skipped: SkippedChain[];
}

/**
 * Fail on a missing or malformed engine key with a message that names the
 * variable and what to do about it.
 *
 * Without this the first thing to touch the value is a base58 decoder, which
 * reports `Unknown letter "_"` from four frames inside `HDKey` and never
 * mentions `CIXTECH_ENGINE_XPRV` -- the placeholder `REPLACE_ME` fails exactly
 * that way, and it is the single most likely value to still be in a new .env.
 * Same posture as `resolveTokenContracts` below and `assertPolicyConfigured`:
 * refuse to start, and say which variable and how to fix it.
 */
function assertEngineKey(value: string | undefined): string {
  const remedy = [
    "Generate one with `make key` (or `cd backend && pnpm generate-engine-key`)",
    "and set CIXTECH_ENGINE_XPRV in backend/.env. Testnet and local development",
    "only -- production keys are a witnessed DKG ceremony (ADR 0007).",
  ].join(" ");

  if (!value || value.trim() === "") {
    throw new InvalidEnvError(`CIXTECH_ENGINE_XPRV is required. ${remedy}`);
  }
  if (value === "REPLACE_ME") {
    throw new InvalidEnvError(
      `CIXTECH_ENGINE_XPRV is still the placeholder from .env.example. ${remedy}`,
    );
  }
  try {
    HDKey.fromExtendedKey(value.trim());
  } catch (cause) {
    throw new InvalidEnvError(
      `CIXTECH_ENGINE_XPRV is not a valid extended private key. ${remedy}`,
      { cause },
    );
  }
  return value.trim();
}

export function buildRouter(env: Env, sql: SqlClient): BuiltRouter {
  const accountXprv = assertEngineKey(env["CIXTECH_ENGINE_XPRV"]);

  const signer = makeTronSigner(accountXprv);
  const engineXpub = HDKey.fromExtendedKey(accountXprv).publicExtendedKey;
  const http = new FetchHttpClient();
  const registry = new ChainRegistry();
  const cursors = new DepositCursorStore(sql);
  const lookback = Number(
    env["CIXTECH_EVM_LOOKBACK_BLOCKS"] ?? String(DEFAULT_EVM_LOOKBACK_BLOCKS),
  );
  const router = new ChainRouter();
  const skipped: SkippedChain[] = [];
  const noRpc = (chain: string, envVar: string) => skipped.push({ chain, reason: `no ${envVar}` });

  const tronRpc = env["TRON_RPC_URL"];
  if (!tronRpc) noRpc("TRON", "TRON_RPC_URL");
  if (tronRpc) {
    const apiKey = env["TRONGRID_API_KEY"];
    const tokenContracts = resolveTokenContracts(registry, env, "TRON");
    const tron = new TronAdapter(http, {
      baseUrl: tronRpc,
      confirmations: TRON_SOLIDIFIED_CONFIRMATIONS,
      ...(apiKey ? { apiKey } : {}),
    });
    router.register({
      chain: "TRON",
      family: "TRON",
      confirmations: TRON_SOLIDIFIED_CONFIRMATIONS,
      broadcaster: new TronPayoutBroadcaster(http, signer, {
        baseUrl: tronRpc,
        tokenContracts,
        feeLimitSun: TRON_FEE_LIMIT_SUN,
        ...(apiKey ? { apiKey } : {}),
      }),
      balances: new TronBalanceProvider(http, tronRpc, tokenContracts, apiKey),
      depositSource: { fetchInbound: (_chain, address) => tron.confirmedInboundTrc20(address) },
      deriveAddress: (xpub, index) => deriveTronAddress(xpub, index),
    });
  }

  for (const chain of EVM_CHAINS) {
    const rpcUrl = env[`${chain}_RPC_URL`];
    if (!rpcUrl) {
      noRpc(chain, `${chain}_RPC_URL`);
      continue;
    }
    const cfg = registry.chain(chain);
    const confirmations = cfg.finality.confirmations;
    const tokenContracts = resolveTokenContracts(registry, env, chain);
    const nativeSymbol = NATIVE_SYMBOL[chain] as string;
    const rpc = new EvmRpc(http, rpcUrl);
    const adapter = new EvmAdapter(rpc, { chain, confirmations, tokenContracts });
    router.register({
      chain,
      family: "EVM",
      confirmations,
      broadcaster: new EvmPayoutBroadcaster(rpc, signer, {
        chainId: BigInt(cfg.chainId ?? 0),
        tokenContracts,
        nativeSymbol,
      }),
      balances: new EvmBalanceProvider(rpc, tokenContracts, nativeSymbol),
      depositSource: new EvmDepositSource(adapter, rpc, cursors, {
        initialLookbackBlocks: lookback,
      }),
      deriveAddress: (xpub, index) => deriveEvmAddress(xpub, index),
    });
  }

  return { router, engineXpub, chains: router.chains(), skipped };
}
