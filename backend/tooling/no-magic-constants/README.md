# no-magic-constants

CI guard for spec §16.5 / principle 8: **no contract address or RPC URL literal
may appear in source outside `chain-config`.** This is what keeps the
testnet→mainnet cutover a config swap rather than a code change.

Two patterns, both chosen because they cannot be confused with anything else in
this codebase:

| Pattern | Matches |
| --- | --- |
| hex address | a bare `0x` followed by exactly 40 hex characters |
| rpc url | an `http(s)` URL containing `infura`, `alchemy`, `quiknode`, `ankr` or `rpc.` |

**Chain IDs are deliberately not matched.** A chain ID is an ordinary small
integer, indistinguishable from a port, a confirmation depth or an array length,
so a literal rule for it would be all false positives. They are held to
`chain-config` by the `ChainConfig.chainId` field and by review, not by this
script — `registry.property.test.ts` is what checks the registry is total.

```bash
pnpm guard:constants          # exits non-zero on a finding
```

Biome can't express this rule today, so it's a dependency-free Node script wired
into the CI gate alongside `biome check` and `tsc`. Chain configs themselves live
in `chain-config` (allowed); everything else must resolve addresses/URLs from the
registry + deployment env vars.
