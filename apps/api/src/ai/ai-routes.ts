import { randomUUID } from "node:crypto";
import {
  type AgentRuleAction,
  type AgentRuleCondition,
  AgenticRulesEngine,
  AnomalyDetector,
  FinancialAiEngine,
} from "@cixtech/ai";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Engine } from "../engine.js";
import type { Scope, Tenant } from "../stores.js";

export interface AiOptions {
  engine: Engine;
  /**
   * Resolve the authenticated tenant for this request, asserting a scope.
   *
   * Supplied by `buildApp` so these routes use the SAME authentication and the
   * SAME scope check as every other `/v1` route. They previously re-authenticated
   * with a private helper that took no scope argument at all, which meant a
   * `read`-only key could register an autonomous rule whose action is
   * PAUSE_WITHDRAWALS — the one thing scopes exist to prevent.
   */
  tenantOf: (req: FastifyRequest, scope?: Scope) => Tenant;
}

export function registerAi(app: FastifyInstance, opts: AiOptions): void {
  const { engine, tenantOf } = opts;
  // The solvency answer comes from the ledger, not from a constant.
  const aiEngine = new FinancialAiEngine(engine.sql, {
    isSolvent: (asset) => engine.ledger.isSolvent(asset),
  });
  const anomalyDetector = new AnomalyDetector(engine.sql);
  const rulesEngine = new AgenticRulesEngine(engine.sql);

  const aiQuerySchema = {
    schema: {
      tags: ["ai"],
      summary: "Natural Language Financial Query Engine",
      description:
        "Translates natural language financial prompts into safe parameterized double-entry sub-ledger queries.",
      body: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: {
            type: "string",
            description: "Financial inquiry (e.g. What is our available USDT float balance?)",
          },
        },
      },
    },
  };

  const aiAnomaliesSchema = {
    schema: {
      tags: ["ai"],
      summary: "Real-Time Financial Anomaly Risk Feed",
      description:
        "Fetches active risk alerts including withdrawal velocity spikes, zero-day address drains, and unallocated float surges.",
    },
  };

  const aiCreateRuleSchema = {
    schema: {
      tags: ["ai"],
      summary: "Create Autonomous Agentic Rule",
      description:
        "Registers an autonomous financial rule with custom triggers (BALANCE_BELOW, VELOCITY_ABOVE, ANOMALY_TRIGGERED).",
      body: {
        type: "object",
        required: ["name", "conditionType", "conditionThreshold", "action"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          conditionType: {
            type: "string",
            enum: ["BALANCE_BELOW", "VELOCITY_ABOVE", "ANOMALY_TRIGGERED"],
          },
          // Same pattern the withdrawal schema uses for base-unit amounts. Without
          // it a non-numeric threshold stores fine and then throws from BigInt()
          // on every later GET /v1/ai/rules — a persistent, self-inflicted 500.
          conditionThreshold: { type: "string", pattern: "^[0-9]+$", maxLength: 40 },
          action: {
            type: "string",
            enum: ["PAUSE_WITHDRAWALS", "NOTIFY", "AUTO_REBALANCE", "REQUIRE_APPROVAL"],
          },
        },
      },
    },
  };

  const aiGetRulesSchema = {
    schema: {
      tags: ["ai"],
      summary: "List Active Autonomous Financial Rules",
      description: "Queries active autonomous rules and evaluation results.",
    },
  };

  // ── Natural Language Query (US-AI-01) ────────────────────────────────────

  /**
   * POST /v1/ai/query — Execute natural language query on ledger & analytics.
   */
  app.post("/v1/ai/query", aiQuerySchema, async (req, reply) => {
    const tenant = tenantOf(req, "read");
    const { prompt } = (req.body ?? {}) as { prompt?: string };

    if (!prompt) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "prompt string is required" },
      });
    }

    const res = await aiEngine.query({
      tenantId: tenant.id,
      prompt,
    });

    return reply.status(200).send({ response: res });
  });

  // ── Financial Anomaly Detector ───────────────────────────────────────────

  /**
   * GET /v1/ai/anomalies — Fetch real-time risk anomalies & compliance flags.
   */
  app.get("/v1/ai/anomalies", aiAnomaliesSchema, async (req, reply) => {
    const tenant = tenantOf(req, "read");
    const anomalies = await anomalyDetector.detectAnomalies(tenant.id);
    return reply.status(200).send({ anomalies });
  });

  // ── Autonomous Agentic Rules ─────────────────────────────────────────────

  /**
   * POST /v1/ai/rules — Create an autonomous financial rule.
   */
  // Creating a rule is a control-changing mutation (PAUSE_WITHDRAWALS,
  // REQUIRE_APPROVAL), so it takes the same scope as any other money-touching write.
  app.post("/v1/ai/rules", aiCreateRuleSchema, async (req, reply) => {
    const tenant = tenantOf(req, "move-funds");
    const body = (req.body ?? {}) as {
      name?: string;
      conditionType?: AgentRuleCondition;
      conditionThreshold?: string;
      action?: AgentRuleAction;
    };

    if (!body.name || !body.conditionType || !body.conditionThreshold || !body.action) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "name, conditionType, conditionThreshold, and action are required",
        },
      });
    }

    // randomUUID, not Math.random: this is a primary key, and ~46 bits from a
    // non-cryptographic PRNG both collides and is guessable from a few samples.
    const id = `rule_${randomUUID()}`;
    const now = new Date();

    await engine.sql.query(
      `INSERT INTO agent_rule (id, tenant_id, name, condition_type, condition_threshold, action)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenant.id, body.name, body.conditionType, body.conditionThreshold, body.action],
    );

    return reply.status(201).send({
      rule: {
        id,
        tenantId: tenant.id,
        name: body.name,
        conditionType: body.conditionType,
        conditionThreshold: body.conditionThreshold,
        action: body.action,
        isActive: true,
        createdAt: now.toISOString(),
      },
    });
  });

  /**
   * GET /v1/ai/rules — List active autonomous financial rules and evaluation results.
   */
  app.get("/v1/ai/rules", aiGetRulesSchema, async (req, reply) => {
    const tenant = tenantOf(req, "read");
    const evaluations = await rulesEngine.evaluateRules(tenant.id);
    return reply.status(200).send({ evaluations });
  });
}
