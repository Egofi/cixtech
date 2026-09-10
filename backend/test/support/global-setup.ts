import { startEmbeddedPostgres } from "./embedded.js";

export const TEST_PG_URL_ENV = "CIXTECH_TEST_PG_URL";

export async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env[TEST_PG_URL_ENV]) return undefined;
  const handle = await startEmbeddedPostgres();
  process.env[TEST_PG_URL_ENV] = handle.url;
  return async () => {
    await handle.stop();
  };
}
