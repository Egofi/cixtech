import { startEmbeddedPostgres } from "./embedded.js";

/**
 * Vitest `globalSetup`: start ONE Postgres for the whole run and publish its URL
 * to the worker processes. Starting a server per test file would pay initdb
 * dozens of times; workers instead carve out an isolated schema each
 * (`freshDatabase`), which costs about a millisecond.
 *
 * Wire it up in a package's vitest config:
 *
 *   globalSetup: ["../testing/src/global-setup.ts"]
 */
export const TEST_PG_URL_ENV = "CIXTECH_TEST_PG_URL";

/**
 * Teardown is the function RETURNED from setup, not a separate export: vitest may
 * evaluate this module more than once, and a module-level handle would then be
 * undefined when teardown ran — leaving a 40 MB data directory behind per run.
 */
export async function setup(): Promise<(() => Promise<void>) | undefined> {
  // Respect an externally provided server (CI with a service container, or a
  // developer pointing at a local Postgres) instead of starting a second one.
  if (process.env[TEST_PG_URL_ENV]) return undefined;
  const handle = await startEmbeddedPostgres();
  process.env[TEST_PG_URL_ENV] = handle.url;
  return async () => {
    await handle.stop();
  };
}
