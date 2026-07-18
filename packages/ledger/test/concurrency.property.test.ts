import { describe, it } from "vitest";

// Runs against a testcontainers Postgres via PrismaLedgerStore (properties 10–11).
describe("concurrency (prisma-store)", () => {
  // Property 10 — N concurrent posts to one account never lose an update.
  it.todo("[10] concurrent appends: final balance == serial application (optimistic version)");

  // Property 11 — two posts sharing an idempotencyKey racing → exactly one set of postings.
  it.todo("[11] racing duplicate idempotencyKey collapses to one set of postings");
});
