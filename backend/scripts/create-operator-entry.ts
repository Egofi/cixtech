import { openDatabase } from "@/api/db.js";
import { AuthStore, requiresTotp } from "@/auth";
import type { PrincipalKind } from "@/auth";

/**
 * The database-side half of `pnpm create-operator`.
 *
 * Kept as TypeScript and bundled by the same pipeline the server uses, so the
 * account this creates is created by exactly the code that will later
 * authenticate it — password parameters, role validation and all.
 */
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
