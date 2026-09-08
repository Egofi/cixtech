"use client";

import { SessionError, apiFetch } from "./session";

/**
 * The data client the console pages use.
 *
 * Both consoles authenticate with an httpOnly session cookie now, so this is a
 * thin naming layer over `apiFetch` — which attaches credentials and the CSRF
 * header. The `admin` / `portal` split is kept because it reads well at the call
 * site and documents which plane a page belongs to; the transport is identical.
 *
 * API keys have not gone anywhere. They remain the credential for a tenant's
 * SERVER calling `/v1` directly, which is what they were always for. What
 * changed is that a person in a browser no longer uses one.
 */

export { SessionError as ApiError };

export const admin = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "POST", ...(body !== undefined ? { body } : {}) }),
};

export const portal = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    apiFetch<T>(path, {
      method: "POST",
      ...(body !== undefined ? { body } : {}),
      ...(headers ? { headers } : {}),
    }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PUT", ...(body !== undefined ? { body } : {}) }),
  del: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};
