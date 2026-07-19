import type { FastifySchema } from "fastify";

// JSON-Schema per route: Fastify validates requests against these AND @fastify/swagger
// turns them into the OpenAPI spec. One definition, two jobs.

const errorResponse = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        id: { type: "string" },
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

export const createAccountSchema: FastifySchema = {
  summary: "Create a sub-account",
  tags: ["accounts"],
  body: {
    type: "object",
    additionalProperties: false,
    properties: { externalRef: { type: "string", maxLength: 256 } },
  },
  response: {
    201: {
      type: "object",
      properties: { id: { type: "string" }, externalRef: { type: ["string", "null"] } },
    },
  },
};

export const depositAddressSchema: FastifySchema = {
  summary: "Assign a pooled deposit address",
  tags: ["accounts"],
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  body: {
    type: "object",
    required: ["chain", "asset"],
    additionalProperties: false,
    properties: {
      chain: { type: "string", enum: ["TRON"] },
      asset: { type: "string", minLength: 1, maxLength: 16 },
    },
  },
  response: {
    201: {
      type: "object",
      properties: { address: { type: "string" }, chain: { type: "string" } },
    },
  },
};

export const balanceSchema: FastifySchema = {
  summary: "Get a per-asset available balance",
  tags: ["accounts"],
  params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  querystring: {
    type: "object",
    required: ["asset"],
    properties: { asset: { type: "string", minLength: 1, maxLength: 16 } },
  },
  response: {
    200: {
      type: "object",
      properties: { asset: { type: "string" }, available: { type: "string" } },
    },
  },
};

export const withdrawalSchema: FastifySchema = {
  summary: "Request a payout",
  tags: ["payouts"],
  params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  headers: {
    type: "object",
    required: ["idempotency-key"],
    properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 255 } },
  },
  body: {
    type: "object",
    required: ["chain", "asset", "amount", "destination"],
    additionalProperties: false,
    properties: {
      chain: { type: "string", enum: ["TRON"] },
      asset: { type: "string", minLength: 1, maxLength: 16 },
      amount: { type: "string", pattern: "^[1-9][0-9]*$" }, // positive integer base units
      destination: { type: "string", minLength: 25, maxLength: 64 },
    },
  },
  response: {
    200: {
      type: "object",
      properties: {
        txId: { type: "string" },
        from: { type: "string" },
        status: { type: "string" },
      },
    },
    403: errorResponse,
    409: errorResponse,
  },
};

export const setWebhookSchema: FastifySchema = {
  summary: "Configure the tenant's outbound webhook",
  tags: ["webhooks"],
  body: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
  },
  response: {
    201: { type: "object", properties: { url: { type: "string" }, secret: { type: "string" } } },
  },
};
