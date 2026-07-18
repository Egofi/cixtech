import { describe, it } from "vitest";

describe("internal reconciler", () => {
  // Property 12 — reports zero drift on any valid history, and NON-zero drift when a
  // posting is mutated out-of-band. Must survive mutation testing, not rubber-stamp.
  it.todo("[12] reconciler catches an out-of-band mutation (drift != 0)");
});
