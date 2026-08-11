import {
  type AgentRuleAction,
  type AgentRuleCondition,
  AgenticRulesEngine,
  AnomalyDetector,
  FinancialAiEngine,
} from "@cixtech/ai";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Engine } from "../engine.js";
import type { Tenant } from "../stores.js";

export interface AiOptions {
  engine: Engine;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

export function registerAi(app: FastifyInstance, opts: AiOptions): void {
  const { engine } = opts;
  const aiEngine = new FinancialAiEngine(engine.sql);
  const anomalyDetector = new AnomalyDetector(engine.sql);
  const rulesEngine = new AgenticRulesEngine(engine.sql);

  const authed = new WeakMap<FastifyRequest, Tenant>();

  const tenantOf = async (req: FastifyRequest): Promise<Tenant> => {
    let t = authed.get(req);
    if (!t) {
      t = await engine.tenants.authenticate(header(req, "x-api-key"));
      authed.set(req, t);
    }
    return t;
  };

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
          name: { type: "string" },
          conditionType: {
            type: "string",
            enum: ["BALANCE_BELOW", "VELOCITY_ABOVE", "ANOMALY_TRIGGERED"],
          },
          conditionThreshold: { type: "string" },
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
    const tenant = await tenantOf(req);
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
    const tenant = await tenantOf(req);
    const anomalies = await anomalyDetector.detectAnomalies(tenant.id);
    return reply.status(200).send({ anomalies });
  });

  // ── Autonomous Agentic Rules ─────────────────────────────────────────────

  /**
   * POST /v1/ai/rules — Create an autonomous financial rule.
   */
  app.post("/v1/ai/rules", aiCreateRuleSchema, async (req, reply) => {
    const tenant = await tenantOf(req);
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

    const id = `rule_${Math.random().toString(36).substring(2, 11)}`;
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
    const tenant = await tenantOf(req);
    const evaluations = await rulesEngine.evaluateRules(tenant.id);
    return reply.status(200).send({ evaluations });
  });
}
