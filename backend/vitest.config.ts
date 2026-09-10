import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const here = import.meta.dirname;

export default defineConfig({
  resolve: {
    // The same aliases tsconfig.json and bundle.mjs use. All three must agree, or
    // a test resolves a different file than the build ships.
    alias: [
      { find: /^@\/types$/, replacement: resolve(here, "types/index.ts") },
      { find: /^@\/types\//, replacement: `${resolve(here, "types")}/` },
      { find: /^@\//, replacement: `${resolve(here, "src")}/` },
      { find: /^@test\//, replacement: `${resolve(here, "test")}/` },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    // One real PostgreSQL server for the run; each test gets its own schema and
    // its handle is released afterwards (test/support/setup.ts).
    globalSetup: ["./test/support/global-setup.ts"],
    setupFiles: ["./test/support/setup.ts"],
    // Each test builds a Fastify app on its own schema; running files in parallel
    // oversubscribes connections. Sequential, with a generous per-test timeout.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
