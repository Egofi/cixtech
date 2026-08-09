import { ChainRegistry } from "@cixtech/chain-config";
import { AppError } from "@cixtech/errors";
import type { SqlClient } from "@cixtech/ledger";
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

/**
 * A chain was reachable but its token configuration is incomplete — the RPC URL
 * is set, so the operator clearly intends to run this chain, but a token the
 * registry says it carries has no contract address in the environment.
 */
export class ChainMisconfiguredError extends AppError {
  readonly code = "CHAIN_MISCONFIGURED";
}

/** A chain that was NOT registered, and the reason, so boot can say so out loud. */
export interface SkippedChain {
  chain: string;
  reason: string;
}

/**
 * Resolve every non-native token the registry lists for this chain, or refuse to
 * register the chain at all.
 *
 * This is deliberately fatal rather than best-effort. An unresolved contract
 * makes the balance providers answer `0` for that asset — and `0` is not an
 * error anywhere downstream, it is a number. The gatherer reads it as "this
 * merchant has no funds on chain" and refuses a payout whose money is sitting
 * right there; an operator then goes looking for missing deposits that were
 * never missing. A chain that cannot price its own tokens must not advertise
 * itself as supported.
 *
 * Native gas tokens carry no contract and are skipped.
 */
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
  /** The chains that were actually wired (had an RPC URL configured). */
  chains: string[];
  /** Chains this build deliberately left out, and why — logged at boot. */
  skipped: SkippedChain[];
}

/**
 * Assemble the ChainRouter from env (ADR 0016). One shared secp256k1 signer
 * controls every chain's addresses (KeypairSigner derives `0/index`, matching
 * deriveTron/EvmAddress). A chain is registered only when its RPC URL is present,
 * so a deployment enables chains by configuration, not code.
 */
export function buildRouter(env: Env, sql: SqlClient): BuiltRouter {
  const accountXprv = env["CIXTECH_ENGINE_XPRV"];
  if (!accountXprv) throw new Error("CIXTECH_ENGINE_XPRV is required");

  const signer = makeTronSigner(accountXprv); // shared HD signer (signHash is chain-agnostic)
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

  // ── Tron ────────────────────────────────────────────────────────────────────
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

  // ── EVM family ────────────────────────────────────────────────────────────────
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
