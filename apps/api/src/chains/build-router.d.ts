import { ChainRouter } from "@cixtech/chains";
import type { SqlClient } from "@cixtech/ledger";
type Env = Record<string, string | undefined>;
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
export declare function buildRouter(env: Env, sql: SqlClient): BuiltRouter;
export {};
