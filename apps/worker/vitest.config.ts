import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../../packages/testing/src/global-setup.ts"],
    setupFiles: ["../../packages/testing/src/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
