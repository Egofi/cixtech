export const SCOPES = ["read", "move-funds", "approve"] as const;

export type Scope = (typeof SCOPES)[number];
