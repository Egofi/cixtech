#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// `pnpm guard:constants` passes `src`. The default matches it so that running the
// script by hand scans the same tree — it used to default to `packages/`, which
// has not existed since the workspace was flattened, so a bare run scanned nothing.
const root = process.argv[2] ?? "src";
const ALLOW_DIR = /[/\\]chain-config[/\\]/;
const IS_SOURCE = /\.(ts|tsx|mjs|cjs|js)$/;
const IS_TEST = /\.(test|spec)\./;

const PATTERNS = [
  { name: "hex address", re: /\b0x[a-fA-F0-9]{40}\b/ },
  { name: "rpc url", re: /https?:\/\/\S*(infura|alchemy|quiknode|ankr|rpc\.)\S*/i },
];

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
