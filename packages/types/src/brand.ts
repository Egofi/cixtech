declare const __brand: unique symbol;

/** Nominal typing helper: `Brand<string, "TenantId">` is not assignable from a bare string. */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };
