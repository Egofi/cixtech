export const SYSTEM_ROUTES = {
  HEALTH: "/health",
  METRICS: "/metrics",
  READY: "/ready",
} as const;

export type SystemRoutePath = (typeof SYSTEM_ROUTES)[keyof typeof SYSTEM_ROUTES];
