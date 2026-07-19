import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test spins up PGlite (WASM Postgres) + a Fastify app; running the
    // files in parallel oversubscribes resources and trips timeouts. Run them
    // sequentially with a generous per-test timeout.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
