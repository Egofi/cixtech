import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // One real PostgreSQL server for the run; each test gets its own schema.
    globalSetup: ["../testing/src/global-setup.ts"],
    setupFiles: ["../testing/src/setup.ts"],
    testTimeout: 60_000,
  },
});
