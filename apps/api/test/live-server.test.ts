import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { auth, makeApi } from "./harness.js";

describe("live HTTP server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("serves over a real socket: health + an authenticated route", async () => {
    const { app, apiKey } = await makeApi();
    await app.listen({ port: 0, host: "127.0.0.1" });
    close = () => app.close();
    const { port } = app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    // Unauthenticated → 401 over the wire.
    const noAuth = await fetch(`${base}/v1/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noAuth.status).toBe(401);

    // Authenticated create-account → 201 with an id.
    const created = await fetch(`${base}/v1/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(apiKey) },
      body: "{}",
    });
    expect(created.status).toBe(201);
    expect(typeof (await created.json()).id).toBe("string");
  });
});
