import type { ChainDeposit, DepositSource, EvmAdapter, EvmRpc } from "@cixtech/chains";
import type { DepositCursorStore } from "./deposit-cursor.js";
export interface EvmDepositSourceConfig {
    /** How many blocks behind the head to start watching a NEW address (never genesis). */
    initialLookbackBlocks: number;
}
/**
 * A finality-gated, RESUMABLE EVM deposit source (ADR 0016). For each watched
 * address it scans `[cursor, head - confirmations]`, credits only finalized ERC20
 * transfers, and advances a durable cursor past the scanned range — so detection
 * survives restarts and never rescans history. A first-seen address seeds its
 * cursor a bounded lookback behind the head, so watching starts cheaply.
 */
export declare class EvmDepositSource implements DepositSource {
    private readonly adapter;
    private readonly rpc;
    private readonly cursors;
    private readonly config;
    constructor(adapter: EvmAdapter, rpc: EvmRpc, cursors: DepositCursorStore, config: EvmDepositSourceConfig);
    fetchInbound(chain: string, address: string): Promise<ChainDeposit[]>;
}
