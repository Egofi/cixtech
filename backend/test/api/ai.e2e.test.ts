import { AgenticRulesEngine, AnomalyDetector, FinancialAiEngine } from "@/ai";
import { describe, expect, it } from "vitest";
import { auth, makeApi } from "./harness.js";

describe("Phase 4: Natural Language Financial Query Engine (US-AI-01)", () => {
  it("parses balance inquiries and generates structured response", async () => {
    const ctx = await makeApi();
    const ai = new FinancialAiEngine(ctx.sql);

    const res = await ai.query({
      tenantId: ctx.tenant.id,
      prompt: "What is our total available merchant float balance?",
    });

    expect(res.intent).toBe("BALANCE_INQUIRY");
    expect(res.confidenceScore).toBeGreaterThan(0.9);
    expect(res.answer).toContain("merchant float");
  });

  it("handles NL query via POST /v1/ai/query API", async () => {
    const ctx = await makeApi();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/ai/query",
      headers: auth(ctx.apiKey),
      payload: { prompt: "Check platform solvency status" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.response.intent).toBe("SOLVENCY_CHECK");

    expect(body.response.answer.toLowerCase()).toMatch(/solvency (holds|invariant)/);
    expect(typeof body.response.data.isSolvent).toBe("boolean");
  });
});

describe("Phase 4: Real-Time Financial Anomaly Detector (US-AI-01)", () => {
  it("detects zero-day address high-volume drain anomalies", async () => {
    const ctx = await makeApi();
    const detector = new AnomalyDetector(ctx.sql);

    for (let i = 0; i < 6; i++) {
      await ctx.sql.query(
        `INSERT INTO payout_allowlist (tenant, merchant, chain, address, usable_at)
         VALUES ($1, $2, $3, $4, now() - interval '10 minutes')`,
        [ctx.tenant.id, "m1", "TRON", `TAddr${i}${Date.now()}`],
      );
    }

    const alerts = await detector.detectAnomalies(ctx.tenant.id);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]?.type).toBe("ZERO_DAY_ADDRESS_DRAIN");
  });

  it("fetches active anomaly feed via GET /v1/ai/anomalies API", async () => {
    const ctx = await makeApi();

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/ai/anomalies",
      headers: auth(ctx.apiKey),
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().anomalies)).toBe(true);
  });
});

describe("Phase 4: Autonomous Agentic Rules Engine (US-AI-01)", () => {
  it("creates autonomous financial rule and evaluates condition triggers", async () => {
    const ctx = await makeApi();

    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/v1/ai/rules",
      headers: auth(ctx.apiKey),
      payload: {
        name: "Auto Pause on Low Balance",
        conditionType: "BALANCE_BELOW",
        conditionThreshold: "100000000", // 100 USDT
        action: "PAUSE_WITHDRAWALS",
      },
    });

    expect(createRes.statusCode).toBe(201);
    const rule = createRes.json().rule;
    expect(rule.name).toBe("Auto Pause on Low Balance");

    const getRes = await ctx.app.inject({
      method: "GET",
      url: "/v1/ai/rules",
      headers: auth(ctx.apiKey),
    });

    expect(getRes.statusCode).toBe(200);
    const evaluations = getRes.json().evaluations;
    expect(evaluations.length).toBe(1);
    expect(evaluations[0].ruleName).toBe("Auto Pause on Low Balance");
    expect(evaluations[0].action).toBe("PAUSE_WITHDRAWALS");
  });
});
