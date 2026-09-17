/**
 * Create a principal: an operator for the admin plane, or a tenant user for
 * `/v1` (ADR 0018). Always sets `mustChangePassword`, so a generated password is
 * a one-time handover rather than a credential.
 *
 * Lives in `src/` rather than `scripts/` so the bundled CLI can reach it: the api
 * image copies `src` and `types` but not `scripts`, and an entry that imported
 * across that line type-checked locally and failed inside the image.
 *
 * It also carried two imports left from the monorepo split -- `@/api/db.js` for
 * `openDatabase` (now `@/postgres`) and `AuthStore` from `@/auth` (now
 * `@/stores`) -- so it did not bundle at all, which meant the documented way to
 * create the FIRST operator never ran.
 */
import { requiresTotp } from "@/auth";
import { openDatabase } from "@/postgres";
import { AuthStore } from "@/stores";
import type { PrincipalKind } from "@/types";

export async function createOperator(input: {
  kind: string;
  email: string;
  role: string;
  tenantId?: string | undefined;
  password: string;
}): Promise<{ ok: true; totpRequired: boolean } | { ok: false; error: string }> {
  const db = openDatabase(process.env);
  try {
    const store = new AuthStore(db.sql);
    const principal = await store.createPrincipal({
      kind: input.kind as PrincipalKind,
      email: input.email,
      password: input.password,
      role: input.role,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      mustChangePassword: true,
    });
    return { ok: true, totpRequired: requiresTotp(principal.role) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await db.close();
  }
}
