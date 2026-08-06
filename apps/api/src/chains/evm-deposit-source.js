/**
 * A finality-gated, RESUMABLE EVM deposit source (ADR 0016). For each watched
 * address it scans `[cursor, head - confirmations]`, credits only finalized ERC20
 * transfers, and advances a durable cursor past the scanned range — so detection
 * survives restarts and never rescans history. A first-seen address seeds its
 * cursor a bounded lookback behind the head, so watching starts cheaply.
 */
export class EvmDepositSource {
    adapter;
    rpc;
    cursors;
    config;
    constructor(adapter, rpc, cursors, config) {
        this.adapter = adapter;
        this.rpc = rpc;
        this.cursors = cursors;
        this.config = config;
    }
    async fetchInbound(chain, address) {
        let cursor = await this.cursors.get(chain, address);
        if (cursor === null) {
            const head = await this.rpc.blockNumber();
            const lookback = BigInt(this.config.initialLookbackBlocks);
            cursor = head > lookback ? head - lookback : 0n;
        }
        const { deposits, scannedTo } = await this.adapter.scanInboundErc20(address, cursor);
        // Advance only when we actually scanned past the cursor (scannedTo >= cursor).
        if (scannedTo >= cursor)
            await this.cursors.set(chain, address, scannedTo + 1n);
        return deposits;
    }
}
//# sourceMappingURL=evm-deposit-source.js.map