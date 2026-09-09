export const AUTH_ROUTES = {
  LOGIN: "/auth/login",
  LOGOUT: "/auth/logout",
  LOGOUT_ALL: "/auth/logout-all",
  MFA: "/auth/mfa",
  PASSWORD: "/auth/password",
  SESSION: "/auth/session",
  SESSIONS: "/auth/sessions",
  SESSIONS_BY_ID: "/auth/sessions/:id",
  TOTP_BEGIN: "/auth/totp/begin",
  TOTP_CONFIRM: "/auth/totp/confirm",
} as const;

export type AuthRoutePath = (typeof AUTH_ROUTES)[keyof typeof AUTH_ROUTES];
