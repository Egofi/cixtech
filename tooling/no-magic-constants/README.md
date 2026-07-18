# no-magic-constants

CI guard for spec §16.5 / principle 8: **no chain id, contract address, or RPC
URL literal may appear in source outside `packages/chain-config`.** This is what
keeps the testnet→mainnet cutover a config swap rather than a code change.

```bash
pnpm guard:constants          # exits non-zero on a finding
```

Biome can't express this rule today, so it's a dependency-free Node script wired
into the CI gate alongside `biome check` and `tsc`. Chain configs themselves live
in `chain-config` (allowed); everything else must resolve addresses/URLs from the
registry + deployment env vars.
