import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const DATA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.test-postgres");

const PORT_SEARCH_START = 55_432;
const PORT_SEARCH_RANGE = 500;
const START_ATTEMPTS = 8;

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(): Promise<number> {
  const offset = Math.floor(Math.random() * PORT_SEARCH_RANGE);
  for (let i = 0; i < PORT_SEARCH_RANGE; i++) {
    const port = PORT_SEARCH_START + ((offset + i) % PORT_SEARCH_RANGE);
    if (await isPortFree(port)) return port;
  }
  throw new Error("No free port for the test Postgres server");
}

export interface EmbeddedHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const USER = "cixtech_test";
const PASSWORD = "cixtech_test";
const DATABASE = "postgres";

export async function startEmbeddedPostgres(): Promise<EmbeddedHandle> {
  let lastError: unknown;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    try {
      return await startOnce();
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not start the test Postgres server after ${START_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function startOnce(): Promise<EmbeddedHandle> {
  const port = await findFreePort();
  mkdirSync(DATA_ROOT, { recursive: true });
  const dataDir = mkdtempSync(join(DATA_ROOT, "pg-"));
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port,
    persistent: false,

    onLog: () => {},
    onError: () => {},
  });

  try {
    await server.initialise();
    await server.start();
  } catch (err) {
    await server.stop().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await server.stop().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  };

  const onExit = () => {
    void stop();
  };
  process.once("exit", onExit);
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  return {
    url: `postgresql://${USER}:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`,
    port,
    stop,
  };
}
