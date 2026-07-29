import { afterEach } from "vitest";
import { closeOpenDatabases } from "./fresh-database.js";

/**
 * Vitest `setupFiles` entry: release every auto-closing test database after each
 * test. Postgres caps concurrent connections, and a handle left open would
 * surface later as an unrelated test failing to connect.
 *
 *   setupFiles: ["../testing/src/setup.ts"]
 */
afterEach(async () => {
  await closeOpenDatabases();
});
