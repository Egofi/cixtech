import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Persistence/concurrency property suites spin up a Postgres container.
    testTimeout: 60_000,
  },
});
