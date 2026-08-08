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
      // Any well-formed chain name; the ChainRouter is the source of truth for
      // which are actually supported (400 UNSUPPORTED_CHAIN otherwise, ADR 0016).
      chain: { type: "string", minLength: 1, maxLength: 32 },
      asset: { type: "string", minLength: 1, maxLength: 16 },
    },
  },
  response: {
    201: {
      type: "object",
      // `asset` is echoed back so a caller showing the address to a payer can state
      // which token to send — the commonest way to lose funds is sending the wrong
      // one to a correct address.
      properties: {
        address: { type: "string" },
        chain: { type: "string" },
        asset: { type: "string" },
      },
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
      // Any well-formed chain name; the ChainRouter is the source of truth for
      // which are actually supported (400 UNSUPPORTED_CHAIN otherwise, ADR 0016).
      chain: { type: "string", minLength: 1, maxLength: 32 },
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
    202: {
      type: "object",
      description: "Held for approval or a time-lock; no funds have moved.",
      properties: {
        withdrawalId: { type: "string" },
        status: { type: "string" },
        approvalsNeeded: { type: "integer" },
        approvalsHave: { type: "integer" },
        until: { type: "string" },
      },
    },
    403: errorResponse,
    409: errorResponse,
  },
};

export const approveWithdrawalSchema: FastifySchema = {
  summary: "Approve a pending payout",
  description: [
    "Records one approval against a payout that is awaiting them.",
    "",
    "Requires a key with the `approve` scope, which is deliberately separate from",
    "`move-funds`: the credential that requested the payout can never approve it,",
    "and M-of-N counts DISTINCT approvers, so one key cannot clear a threshold by",
    "approving repeatedly. When the last required approval lands, the payout",
    "proceeds and this returns its transaction.",
  ].join("\n"),
  tags: ["payouts"],
  params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  response: {
    200: {
      type: "object",
      properties: {
        withdrawalId: { type: "string" },
        status: { type: "string" },
        txId: { type: "string" },
        from: { type: "string" },
        approvals: { type: "array", items: { type: "string" } },
      },
    },
    202: {
      type: "object",
      description: "Approval recorded; still short of the required quorum.",
      properties: {
        withdrawalId: { type: "string" },
        status: { type: "string" },
        approvalsNeeded: { type: "integer" },
        approvalsHave: { type: "integer" },
      },
    },
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
  },
};

export const chainsSchema: FastifySchema = {
  summary: "List the chains this deployment routes, and the assets they carry",
  tags: ["chains"],
  response: {
    200: {
      type: "object",
      properties: {
        chains: { type: "array", items: { type: "string" } },
        // Which network this deployment is pointed at (§16.5). testnet and
        // mainnet are separate deployments, so this is fixed for the process —
        // but a console showing balances should never have to guess which.
        env: { type: "string", enum: ["testnet", "mainnet"] },
        // Amounts on every other endpoint are integer base units. Divide by
        // 10^decimals before showing one to a person.
        assets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              decimals: { type: "integer" },
              chains: { type: "array", items: { type: "string" } },
              native: { type: "boolean" },
            },
          },
        },
      },
    },
  },
};

const limitQuery = {
  type: "object",
  properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
} as const;

export const listAccountsSchema: FastifySchema = {
  summary: "List your sub-accounts",
  tags: ["accounts"],
  querystring: limitQuery,
  response: {
    200: {
      type: "object",
      properties: {
        accounts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              externalRef: { type: ["string", "null"] },
              createdAt: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export const listDepositAddressesSchema: FastifySchema = {
  summary: "List an account's deposit addresses",
  tags: ["accounts"],
  params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  response: {
    200: {
      type: "object",
      properties: {
        addresses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              chain: { type: "string" },
              address: { type: "string" },
              state: { type: "string" },
              cooldownUntil: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  },
};

export const listBalancesSchema: FastifySchema = {
  summary: "All available balances across your accounts",
  tags: ["accounts"],
  response: {
    200: {
      type: "object",
      properties: {
        balances: {
          type: "array",
          items: {
            type: "object",
            properties: {
              accountId: { type: "string" },
              asset: { type: "string" },
              available: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export const listDepositsSchema: FastifySchema = {
  summary: "Your deposit history (credits at finality, quarantines, reversals)",
  tags: ["activity"],
  querystring: limitQuery,
  response: {
    200: {
      type: "object",
      properties: {
        deposits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string" },
              occurredAt: { type: "string" },
              asset: { type: "string" },
              amount: { type: "string" },
              grossAmount: { type: "string" },
              feeCollected: { type: "string" },
              feeBps: { type: "number" },
              feePercent: { type: "string" },
              netCredited: { type: "string" },
              accountId: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  },
};

export const listPayoutsSchema: FastifySchema = {
  summary: "Your payout history with live status",
  tags: ["activity"],
  querystring: limitQuery,
  response: {
    200: {
      type: "object",
      properties: {
        payouts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              idempotencyKey: { type: "string" },
              accountId: { type: "string" },
              chain: { type: "string" },
              asset: { type: "string" },
              amount: { type: "string" },
              destination: { type: "string" },
              status: { type: "string" },
              txId: { type: ["string", "null"] },
              createdAt: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export const listAllowlistSchema: FastifySchema = {
  summary: "Your allow-listed payout destinations (with cool-down state)",
  tags: ["payouts"],
  querystring: limitQuery,
  response: {
    200: {
      type: "object",
      properties: {
        allowlist: {
          type: "array",
          items: {
            type: "object",
            properties: {
              accountId: { type: "string" },
              chain: { type: "string" },
              address: { type: "string" },
              usableAt: { type: "string" },
              addedAt: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export const getWebhookSchema: FastifySchema = {
  summary: "Your webhook endpoint configuration (secret never returned)",
  tags: ["webhooks"],
  response: {
    200: { type: "object", properties: { url: { type: ["string", "null"] } } },
  },
};

export const listWebhookDeliveriesSchema: FastifySchema = {
  summary: "Your webhook delivery history",
  tags: ["webhooks"],
  querystring: limitQuery,
  response: {
    200: {
      type: "object",
      properties: {
        deliveries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              event: { type: "string" },
              status: { type: "string" },
              attempts: { type: "integer" },
              lastError: { type: ["string", "null"] },
              createdAt: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export const allowlistSchema: FastifySchema = {
  summary: "Add a payout destination to the allow-list (cool-down applies)",
  tags: ["payouts"],
  params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  body: {
    type: "object",
    required: ["chain", "address"],
    additionalProperties: false,
    properties: {
      chain: { type: "string", minLength: 1, maxLength: 32 },
      address: { type: "string", minLength: 25, maxLength: 64 },
    },
  },
  response: {
    201: {
      type: "object",
      properties: {
        chain: { type: "string" },
        address: { type: "string" },
        usableAt: { type: "string" },
      },
    },
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
