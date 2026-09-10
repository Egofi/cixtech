export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

import type { Scope } from "../enums/scope.js";

export type RouteAccess<P extends string = string> =
  | { readonly kind: "public" }
  | { readonly kind: "tenant"; readonly scope: Scope }
  | { readonly kind: "session" }
  | { readonly kind: "admin-token" }
  | { readonly kind: "operator"; readonly permission: P };

export interface RouteDescriptor {
  readonly method: HttpMethod;
  readonly path: string;
}
