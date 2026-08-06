import {
  ErpSyncService,
  type ErpTarget,
  type ExportFormat,
  LedgerExporter,
} from "@cixtech/accounting";
import { RefundService, type RefundReason } from "@cixtech/chains";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Engine } from "../engine.js";
import { type Tenant } from "../stores.js";

export interface AccountingOptions {
  engine: Engine;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

export function registerAccounting(app: FastifyInstance, opts: AccountingOptions): void {
  const { engine } = opts;
  const refundService = new RefundService(engine.payouts, engine.ledger);
  const exporter = new LedgerExporter(engine.sql);
  const erpSync = new ErpSyncService(engine.sql);

  const authed = new WeakMap<FastifyRequest, Tenant>();

  const tenantOf = async (req: FastifyRequest): Promise<Tenant> => {
    let t = authed.get(req);
    if (!t) {
      t = await engine.tenants.authenticate(header(req, "x-api-key"));
      authed.set(req, t);
    }
    return t;
  };

  const postRefundSchema = {
    schema: {
      tags: ["accounting"],
      summary: "Process Sub-Minute Automated Customer Refund",
      description: "Triggers automated customer refund with gas fee deduction within < 60 seconds.",
      body: {
        type: "object",
        required: ["merchantId", "chain", "asset", "amountBaseUnits", "destinationAddress", "reason"],
        properties: {
          merchantId: { type: "string" },
          chain: { type: "string" },
          asset: { type: "string" },
          amountBaseUnits: { type: "string" },
          destinationAddress: { type: "string" },
          reason: {
            type: "string",
            enum: ["OVERPAYMENT", "UNDERPAYMENT", "EXPIRED_INTENT", "CUSTOMER_REQUEST", "COMPLIANCE_REJECT"],
          },
          originalTxHash: { type: "string" },
          sponsorGas: { type: "boolean" },
        },
      },
    },
  };

  const getRefundSchema = {
    schema: {
      tags: ["accounting"],
      summary: "Lookup Refund Status",
      description: "Retrieves status of a customer refund transaction.",
      params: {
        type: "object",
        properties: { id: { type: "string" } },
      },
    },
  };

  const exportGlSchema = {
    schema: {
      tags: ["accounting"],
      summary: "Download GAAP/IFRS General Ledger Trial Balance Export",
      description: "Exports trial balance mapped to standard 4-digit GAAP/IFRS GL codes (QuickBooks CSV, Xero CSV, SWIFT MT940, CAMT.053 XML, JSON).",
      querystring: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["quickbooks", "xero", "mt940", "camt053", "json", "csv"] },
        },
      },
    },
  };

  const erpSyncSchema = {
    schema: {
      tags: ["accounting"],
      summary: "Trigger Automated ERP Integration Sync",
      description: "Posts sub-ledger trial balance entries directly to QuickBooks Online, Xero, or NetSuite.",
      body: {
        type: "object",
        required: ["target"],
        properties: {
          target: { type: "string", enum: ["QUICKBOOKS_ONLINE", "XERO", "NETSUITE"] },
        },
      },
    },
  };

  // ── Refund Endpoints (US-RFD-01) ──────────────────────────────────────────

  /**
   * POST /v1/refunds — Trigger an automated customer refund within < 60 seconds.
   */
  app.post("/v1/refunds", postRefundSchema, async (req, reply) => {
    const tenant = await tenantOf(req);
    const body = (req.body ?? {}) as {
      merchantId?: string;
      chain?: string;
      asset?: string;
      amountBaseUnits?: string;
      destinationAddress?: string;
      reason?: RefundReason;
      originalTxHash?: string;
      sponsorGas?: boolean;
    };

    if (
      !body.merchantId ||
      !body.chain ||
      !body.asset ||
      !body.amountBaseUnits ||
      !body.destinationAddress ||
      !body.reason
    ) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message:
            "merchantId, chain, asset, amountBaseUnits, destinationAddress, and reason are required",
        },
      });
    }

    await engine.tenants.requireAccount(tenant.id, body.merchantId);

    const idempotencyKey =
      header(req, "idempotency-key") ?? `ref_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const res = await refundService.processRefund({
      tenantId: tenant.id,
      merchantId: body.merchantId,
      chain: body.chain,
      asset: body.asset,
      amountBaseUnits: BigInt(body.amountBaseUnits),
      destinationAddress: body.destinationAddress,
      reason: body.reason,
      originalTxHash: body.originalTxHash,
      idempotencyKey,
      sponsorGas: body.sponsorGas,
    });

    // Save refund record into database
    await engine.sql.query(
      `INSERT INTO refund (
        id, tenant_id, merchant_id, chain, asset, gross_amount_base_units,
        gas_deduction_base_units, net_amount_base_units, destination_address,
        reason, tx_id, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        res.refundId,
        tenant.id,
        body.merchantId,
        res.chain,
        res.asset,
        res.grossAmountBaseUnits.toString(),
        res.gasDeductionBaseUnits.toString(),
        res.netAmountBaseUnits.toString(),
        res.destinationAddress,
        res.reason,
        res.txId ?? null,
        res.status,
      ],
    );

    return reply.status(201).send({
      refund: {
        id: res.refundId,
        chain: res.chain,
        asset: res.asset,
        grossAmountBaseUnits: res.grossAmountBaseUnits.toString(),
        gasDeductionBaseUnits: res.gasDeductionBaseUnits.toString(),
        netAmountBaseUnits: res.netAmountBaseUnits.toString(),
        destinationAddress: res.destinationAddress,
        reason: res.reason,
        txId: res.txId ?? null,
        status: res.status,
        createdAt: res.createdAt.toISOString(),
      },
    });
  });

  /**
   * GET /v1/refunds/:id — Lookup refund status.
   */
  app.get("/v1/refunds/:id", getRefundSchema, async (req, reply) => {
    const tenant = await tenantOf(req);
    const { id } = req.params as { id: string };

    const { rows } = await engine.sql.query<{
      id: string;
      merchant_id: string;
      chain: string;
      asset: string;
      gross_amount_base_units: string;
      gas_deduction_base_units: string;
      net_amount_base_units: string;
      destination_address: string;
      reason: string;
      tx_id: string | null;
      status: string;
      created_at: string;
    }>("SELECT * FROM refund WHERE id = $1 AND tenant_id = $2", [id, tenant.id]);

    const r = rows[0];
    if (!r) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "refund record not found" } });
    }

    return reply.send({
      refund: {
        id: r.id,
        merchantId: r.merchant_id,
        chain: r.chain,
        asset: r.asset,
        grossAmountBaseUnits: r.gross_amount_base_units,
        gasDeductionBaseUnits: r.gas_deduction_base_units,
        netAmountBaseUnits: r.net_amount_base_units,
        destinationAddress: r.destination_address,
        reason: r.reason,
        txId: r.tx_id,
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
      },
    });
  });

  // ── Sub-Ledger Export & ERP Sync (US-ACC-01, US-ACC-02) ───────────────────

  /**
   * GET /v1/accounting/export — Download GAAP/IFRS General Ledger export (US-ACC-01).
   */
  app.get("/v1/accounting/export", exportGlSchema, async (req, reply) => {
    const tenant = await tenantOf(req);
    const query = (req.query ?? {}) as { format?: string };

    let format: ExportFormat = "CSV";
    const requested = (query.format ?? "").toUpperCase();

    if (requested === "QUICKBOOKS" || requested === "QUICKBOOKS_CSV") {
      format = "QUICKBOOKS_CSV";
    } else if (requested === "XERO" || requested === "XERO_CSV") {
      format = "XERO_CSV";
    } else if (requested === "MT940") {
      format = "MT940";
    } else if (requested === "CAMT053") {
      format = "CAMT053";
    } else if (requested === "JSON") {
      format = "JSON";
    }

    const exportedData = await exporter.export(tenant.id, format);

    const contentTypes: Record<ExportFormat, string> = {
      QUICKBOOKS_CSV: "text/csv",
      XERO_CSV: "text/csv",
      MT940: "text/plain",
      CAMT053: "text/xml",
      JSON: "application/json",
      CSV: "text/csv",
    };

    return reply
      .header("content-type", contentTypes[format] ?? "text/plain")
      .header("content-disposition", `attachment; filename="cixtech_gl_export_${tenant.id}.${format.toLowerCase().replace("_csv", "")}.csv"`)
      .send(exportedData);
  });

  /**
   * POST /v1/accounting/erp-sync — Trigger automated ERP integration sync (US-ACC-02).
   */
  app.post("/v1/accounting/erp-sync", erpSyncSchema, async (req, reply) => {
    const tenant = await tenantOf(req);
    const { target } = (req.body ?? {}) as { target?: ErpTarget };

    if (!target || !["QUICKBOOKS_ONLINE", "XERO", "NETSUITE"].includes(target)) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "target must be QUICKBOOKS_ONLINE, XERO, or NETSUITE",
        },
      });
    }

    const result = await erpSync.sync({
      tenantId: tenant.id,
      target,
    });

    return reply.status(200).send({ sync: result });
  });
}
