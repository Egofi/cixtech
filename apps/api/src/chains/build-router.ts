import { ChainRegistry } from "@cixtech/chain-config";
import {
  ChainRouter,
  EvmAdapter,
  EvmBalanceProvider,
  EvmPayoutBroadcaster,
  EvmRpc,
  FetchHttpClient,
  TronAdapter,
  TronBalanceProvider,
  TronPayoutBroadcaster,
  deriveEvmAddress,
  deriveTronAddress,
  makeTronSigner,
} from "@cixtech/chains";
import type { SqlClient } from "@cixtech/ledger";
import { HDKey } from "@scure/bip32";
import { DepositCursorStore } from "./deposit-cursor.js";
import { EvmDepositSource } from "./evm-deposit-source.js";

const TRON_SOLIDIFIED_CONFIRMATIONS = 19;
const TRON_FEE_LIMIT_SUN = 100_000_000;
const DEFAULT_EVM_LOOKBACK_BLOCKS = 5_000;
const EVM_CHAINS = ["POLYGON", "BSC", "ARBITRUM", "BASE"] as const;
const NATIVE_SYMBOL: Record<string, string> = {
  POLYGON: "POL",
  BSC: "BNB",
  ARBITRUM: "ETH",
  BASE: "ETH",
};

type Env = Record<string, string | undefined>;

/** Resolve the ERC20 contracts configured for a chain (symbol → address from env). */
function evmTokenContracts(
  registry: ChainRegistry,
  env: Env,
  chain: string,
): Record<string, string> {
  const contracts: Record<string, string> = {};
  for (const symbol of ["USDC", "USDT"]) {
    const envVar = registry.token(chain, symbol).contractAddressEnvVar;
    const address = env[envVar];
    if (address) contracts[symbol] = address;
  }
  return contracts;
}

export interface BuiltRouter {
  router: ChainRouter;
  engineXpub: string;
  /** The chains that were actually wired (had an RPC URL configured). */
  chains: string[];
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

  // ── Tron ────────────────────────────────────────────────────────────────────
  const tronRpc = env["TRON_RPC_URL"];
  if (tronRpc) {
    const apiKey = env["TRONGRID_API_KEY"];
    const usdt = env["TRON_USDT_ADDRESS"];
    const tokenContracts: Record<string, string> = usdt ? { USDT: usdt } : {};
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
    if (!rpcUrl) continue;
    const cfg = registry.chain(chain);
    const confirmations = cfg.finality.confirmations;
    const tokenContracts = evmTokenContracts(registry, env, chain);
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

  return { router, engineXpub, chains: router.chains() };
}
