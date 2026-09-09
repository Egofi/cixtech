export function apiBase(): string {
  if (typeof window === "undefined") return "";
  return (window.CIXTECH?.apiBase ?? "").replace(/\/+$/, "");
}

export const apiUrl = (path: string): string => `${apiBase()}${path}`;
