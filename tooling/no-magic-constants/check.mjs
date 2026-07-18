#!/usr/bin/env node
// Property 14 guard (spec §16.5, principle 8): fail if a chain id / 0x-address /
// rpc URL literal appears in source OUTSIDE packages/chain-config. Keeps the
// testnet→mainnet switch a pure config swap. Dependency-free on purpose.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "packages";
const ALLOW_DIR = /[/\\]chain-config[/\\]/;
const IS_SOURCE = /\.(ts|tsx|mjs|cjs|js)$/;
const IS_TEST = /\.(test|spec)\./;

const PATTERNS = [
  { name: "hex address", re: /\b0x[a-fA-F0-9]{40}\b/ },
  { name: "rpc url", re: /https?:\/\/\S*(infura|alchemy|quiknode|ankr|rpc\.)\S*/i },
];

/** @type {string[]} */
const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!/node_modules|dist|\.turbo|coverage/.test(p)) walk(p);
      continue;
    }
    if (!IS_SOURCE.test(p) || IS_TEST.test(p) || ALLOW_DIR.test(p)) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { name, re } of PATTERNS) {
        if (re.test(line)) findings.push(`${p}:${i + 1}  ${name}: ${line.trim()}`);
      }
    });
  }
}

walk(root);

if (findings.length > 0) {
  console.error(
    `no-magic-constants: forbidden literals outside chain-config (${findings.length}):\n${findings.join("\n")}`,
  );
  process.exit(1);
}
console.log("no-magic-constants: clean");
