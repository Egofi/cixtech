import { randomUUID } from "node:crypto";
import { AgenticRulesEngine, AnomalyDetector, FinancialAiEngine } from "@/ai";
import { TENANT_ROUTES } from "@/common/routes";
import { kyselyFor } from "@/postgres";
import { agentRule } from "@/queries";

import type { AgentRuleAction, AgentRuleCondition, Scope, Tenant } from "@/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Engine } from "../engine.js";

export interface AiOptions {
  engine: Engine;

  tenantOf: (req: FastifyRequest, scope?: Scope) => Tenant;
}

export function registerAi(app: FastifyInstance, opts: AiOptions): void {
  const { engine, tenantOf } = opts;

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

  app.post(TENANT_ROUTES.AI_QUERY, aiQuerySchema, async (req, reply) => {
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

  app.get(TENANT_ROUTES.AI_ANOMALIES, aiAnomaliesSchema, async (req, reply) => {
    const tenant = tenantOf(req, "read");
    const anomalies = await anomalyDetector.detectAnomalies(tenant.id);
    return reply.status(200).send({ anomalies });
  });

  app.post(TENANT_ROUTES.AI_RULES, aiCreateRuleSchema, async (req, reply) => {
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

    const id = `rule_${randomUUID()}`;
    const now = new Date();

    await agentRule
      .insert(kyselyFor(engine.sql), {
        id,
        tenant_id: tenant.id,
        name: body.name,
        condition_type: body.conditionType,
        condition_threshold: body.conditionThreshold,
        action: body.action,
      })
      .execute();

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

  app.get(TENANT_ROUTES.AI_RULES, aiGetRulesSchema, async (req, reply) => {
    const tenant = tenantOf(req, "read");
    const evaluations = await rulesEngine.evaluateRules(tenant.id);
    return reply.status(200).send({ evaluations });
  });
}
