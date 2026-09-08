/** Minimal HTTP boundary so adapters are testable with fixtures and swappable per host. */
export interface HttpClient {
  getJson<T>(url: string, headers?: Record<string, string>): Promise<T>;
  postJson<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
}

/** Production client over global `fetch` (Node 20+). */
export class FetchHttpClient implements HttpClient {
  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  }

  async postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  }
}
