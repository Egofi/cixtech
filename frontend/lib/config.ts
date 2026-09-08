/**
 * Where the browser reaches the cixtech API.
 *
 * This is deliberately NOT a `NEXT_PUBLIC_*` variable. Next inlines those at
 * build time, which would mean one image per environment and an image promoted
 * from staging to production still pointing at staging. The consoles are a static
 * artifact that must be immutable and environment-agnostic.
 *
 * Instead `/config.js` sets `window.CIXTECH` and is written by the container
 * entrypoint from `CIXTECH_API_BASE` at start-up. The root layout loads it before
 * anything else, so it is present by the time any component calls the API.
 *
 * An empty base means same-origin, which keeps a reverse proxy that fronts both
 * the consoles and the API under one hostname working with no configuration.
 */
export function apiBase(): string {
  if (typeof window === "undefined") return "";
  return (window.CIXTECH?.apiBase ?? "").replace(/\/+$/, "");
}

/** Prefix a path with the configured API base. */
export const apiUrl = (path: string): string => `${apiBase()}${path}`;
