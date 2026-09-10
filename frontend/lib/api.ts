"use client";

import { SessionError, apiFetch } from "./session";

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
