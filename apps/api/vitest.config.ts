import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One real PostgreSQL server for the run; each test gets its own schema and
    // its handle is released afterwards (setup.ts).
    globalSetup: ["../../packages/testing/src/global-setup.ts"],
    setupFiles: ["../../packages/testing/src/setup.ts"],
    // Each test builds a Fastify app on its own schema; running files in parallel
    // oversubscribes connections. Sequential, with a generous per-test timeout.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
