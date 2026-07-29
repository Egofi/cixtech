import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

/**
 * A real PostgreSQL server for the test suite.
 *
 * Why not PGlite: it is Postgres compiled to WASM, single-connection, and running
 * as a superuser — so it can prove SQL correctness but cannot prove any of the
 * things this codebase actually depends on in production. Connection-pool
 * transaction scoping, savepoint nesting, genuine concurrent writers, and
 * row-level security all behave differently or not at all there (a superuser
 * bypasses RLS entirely, which is exactly the trap ADR 0013 documents).
 *
 * Why not testcontainers: it needs Docker, so a run leaves containers and volumes
 * outside this repository — and on a machine where the daemon refuses `stop`,
 * leaves them permanently. `embedded-postgres` runs a real Postgres binary as a
 * child process of the test run, listening on loopback, with its data directory
 * under `.test-postgres/` in this repo. Everything it creates lives inside the
 * project and is removed when the run ends.
 */

/** Repo-local root for test clusters, so nothing is written outside the project. */
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

/**
 * Probing a port and then binding it is inherently racy, and turbo runs several
 * packages' suites at once — each starting its own server. So the search starts
 * at a random offset to make collisions unlikely, and `startEmbeddedPostgres`
 * retries on a different port when one happens anyway.
 */
async function findFreePort(): Promise<number> {
  const offset = Math.floor(Math.random() * PORT_SEARCH_RANGE);
  for (let i = 0; i < PORT_SEARCH_RANGE; i++) {
    const port = PORT_SEARCH_START + ((offset + i) % PORT_SEARCH_RANGE);
    if (await isPortFree(port)) return port;
  }
  throw new Error("No free port for the test Postgres server");
}

export interface EmbeddedHandle {
  /** Connection string for the superuser/owner role. */
  url: string;
  port: number;
  stop(): Promise<void>;
}

const USER = "cixtech_test";
const PASSWORD = "cixtech_test";
const DATABASE = "postgres";

/**
 * Start a throwaway Postgres. The data directory is a fresh temp dir that is
 * removed on stop, so a run leaves nothing behind — no containers, no volumes,
 * nothing written into the repository.
 */
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
    // initdb/postgres chatter would drown the test reporter.
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

  // A crashed or interrupted run must not leave a postgres process behind.
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
