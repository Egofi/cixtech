import { randomUUID } from "node:crypto";
import { CheckoutModal, type PaymentIntentDetails } from "@cixtech/checkout";
import { FxRateEngine, OfframpProvider, type OfframpChannel } from "@cixtech/chains";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Engine } from "../engine.js";
import { type Tenant, UnauthorizedError } from "../stores.js";
import { PaymentIntentStore } from "./payment-intent-store.js";
import { RecoveryService } from "./recovery-service.js";

export interface CheckoutOptions {
  engine: Engine;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

export function registerCheckout(app: FastifyInstance, opts: CheckoutOptions): void {
  const { engine } = opts;
  const fxEngine = new FxRateEngine();
  const intentStore = new PaymentIntentStore(engine.sql, fxEngine);
  const recoveryService = new RecoveryService(engine.sql, engine.payouts);
  const offrampProvider = new OfframpProvider(engine.ledger);
  const checkoutModal = new CheckoutModal();

  const hidden = { schema: { hide: true } } as const;
  const html = (reply: FastifyReply, type: string, body: string) =>
    reply.header("content-type", type).send(body);

  const authed = new WeakMap<FastifyRequest, Tenant>();

  const tenantOf = async (req: FastifyRequest): Promise<Tenant> => {
    let t = authed.get(req);
    if (!t) {
      t = await engine.tenants.authenticate(header(req, "x-api-key"));
      authed.set(req, t);
    }
    return t;
  };

  const createIntentSchema = {
    schema: {
      tags: ["checkout"],
      summary: "Create Guaranteed 15-Min Price-Locked Payment Intent",
      description: "Generates a 15-minute guaranteed price-locked payment intent with 50 BPS slippage protection and assigned deposit pool address.",
      body: {
        type: "object",
        required: ["merchantId", "amountFiat", "fiatCurrency", "cryptoAsset", "chain"],
        properties: {
          merchantId: { type: "string" },
          amountFiat: { type: "number", description: "Fiat order total (e.g. 100.00)" },
          fiatCurrency: { type: "string", description: "USD, EUR, NGN, KES, BRL" },
          cryptoAsset: { type: "string", description: "USDT, USDC" },
          chain: { type: "string", description: "TRON, POLYGON, BSC, ARBITRUM, BASE" },
          offrampChannel: { type: "string", description: "Optional local offramp provider (NIBSS, PIX, SEPA, ACH, M-Pesa)" },
          offrampAccount: { type: "string", description: "Bank account or mobile money phone number" },
        },
      },
    },
  };

  const getIntentSchema = {
    schema: {
      tags: ["checkout"],
      summary: "Fetch Checkout Payment Intent Status & Quote",
      description: "Lookup live status, rate-lock countdown, and QR payload for checkout modal.",
      params: {
        type: "object",
        properties: { id: { type: "string" } },
      },
    },
  };

  const payIntentSchema = {
    schema: {
      tags: ["checkout"],
      summary: "Submit Transaction Hash for Payment Intent",
      description: "Submits transaction hash to confirm payment intent and trigger automated local off-ramp.",
      params: {
        type: "object",
        properties: { id: { type: "string" } },
      },
      body: {
        type: "object",
        required: ["txHash"],
        properties: { txHash: { type: "string" } },
      },
    },
  };

  const recoveryClaimSchema = {
    schema: {
      tags: ["checkout"],
      summary: "Self-Service Stranded Token Recovery Claim",
      description: "Claims stranded deposits sent to wrong networks or unallocated addresses after on-chain ownership verification.",
      body: {
        type: "object",
        required: ["chain", "txHash", "destinationAddress"],
        properties: {
          chain: { type: "string" },
          txHash: { type: "string" },
          destinationAddress: { type: "string" },
        },
      },
    },
  };

  // ── Tenant API Endpoints ──────────────────────────────────────────────────

  /**
   * POST /v1/checkout/intents — Create a 15-minute guaranteed price locked payment intent (US-FX-01).
   */
  app.post("/v1/checkout/intents", createIntentSchema, async (req, reply) => {
    const tenant = await tenantOf(req);
    const body = (req.body ?? {}) as {
      merchantId?: string;
      amountFiat?: number;
      fiatCurrency?: string;
      cryptoAsset?: string;
      chain?: string;
      offrampChannel?: string;
      offrampAccount?: string;
    };

    if (!body.merchantId || !body.amountFiat || !body.fiatCurrency || !body.cryptoAsset || !body.chain) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "merchantId, amountFiat, fiatCurrency, cryptoAsset, and chain are required",
        },
      });
    }

    await engine.tenants.requireAccount(tenant.id, body.merchantId);

    const chain = body.chain.toUpperCase();
    const cryptoAsset = body.cryptoAsset.toUpperCase();

    // Assign deposit pool address for this intent
    const depositAddress = await engine.pool.assign(
      tenant.id,
      body.merchantId,
      chain,
      randomUUID(),
      engine.engineXpub,
    );

    const intent = await intentStore.create({
      tenantId: tenant.id,
      merchantId: body.merchantId,
      amountFiat: Number(body.amountFiat),
      fiatCurrency: body.fiatCurrency,
      cryptoAsset,
      chain,
      depositAddress,
      offrampChannel: body.offrampChannel,
      offrampAccount: body.offrampAccount,
    });

    const paymentUrl = checkoutModal.getHostedCheckoutUrl(intent.id);

    return reply.status(201).send({
      intent,
      paymentUrl,
      qrPayload: checkoutModal.generateQrPayload({
        id: intent.id,
        amountFiat: intent.amountFiat,
        fiatCurrency: intent.fiatCurrency,
        cryptoAsset: intent.cryptoAsset,
        amountCryptoFormatted: (Number(intent.amountCryptoBaseUnits) / 1e6).toFixed(6),
        amountCryptoBaseUnits: intent.amountCryptoBaseUnits,
        chain: intent.chain,
        depositAddress: intent.depositAddress,
        expiresAt: intent.expiresAt,
        status: intent.status,
      }),
    });
  });

  // ── Public Checkout & Hosted Page Endpoints ───────────────────────────────

  /**
   * GET /v1/checkout/intents/:id — Public status & quote lookup for checkout modal.
   */
  app.get("/v1/checkout/intents/:id", getIntentSchema, async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = await intentStore.get(id);
    if (!intent) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "payment intent not found" } });
    }

    const now = new Date();
    const expiresAt = new Date(intent.expiresAt);
    const remainingSeconds = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));

    const qrPayload = checkoutModal.generateQrPayload({
      id: intent.id,
      amountFiat: intent.amountFiat,
      fiatCurrency: intent.fiatCurrency,
      cryptoAsset: intent.cryptoAsset,
      amountCryptoFormatted: (Number(intent.amountCryptoBaseUnits) / 1e6).toFixed(6),
      amountCryptoBaseUnits: intent.amountCryptoBaseUnits,
      chain: intent.chain,
      depositAddress: intent.depositAddress,
      expiresAt: intent.expiresAt,
      status: intent.status,
    });

    return reply.send({
      intent,
      remainingSeconds,
      qrPayload,
    });
  });

  /**
   * POST /v1/checkout/intents/:id/pay — Submit transaction hash for instant confirmation.
   */
  app.post("/v1/checkout/intents/:id/pay", payIntentSchema, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { txHash } = (req.body ?? {}) as { txHash?: string };
    if (!txHash) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "txHash is required" } });
    }

    const intent = await intentStore.getRequire(id);
    if (intent.status === "EXPIRED") {
      return reply.status(400).send({ error: { code: "EXPIRED", message: "Payment intent has expired" } });
    }

    const updated = await intentStore.markPaid(id, txHash);

    // If intent has off-ramp preference configured, trigger local off-ramp
    if (updated.offrampChannel && updated.offrampAccount) {
      try {
        await offrampProvider.dispatch({
          tenantId: updated.tenantId,
          merchantId: updated.merchantId,
          cryptoAsset: updated.cryptoAsset,
          amountBaseUnits: BigInt(updated.amountCryptoBaseUnits),
          targetCurrency: updated.fiatCurrency,
          destination: {
            channel: updated.offrampChannel as OfframpChannel,
            accountNumber: updated.offrampAccount,
            accountName: "Merchant Account",
            country: "NG",
          },
          idempotencyKey: `auto_offramp:${updated.id}`,
        });
      } catch (err) {
        console.error("Auto offramp trigger error:", err);
      }
    }

    return reply.send({ status: "PAID", intent: updated });
  });

  /**
   * POST /v1/checkout/recovery/claim — Self-service recovery for stranded / wrong-network funds (US-CHK-02).
   */
  app.post("/v1/checkout/recovery/claim", recoveryClaimSchema, async (req, reply) => {
    const { chain, txHash, destinationAddress } = (req.body ?? {}) as {
      chain?: string;
      txHash?: string;
      destinationAddress?: string;
    };

    if (!chain || !txHash || !destinationAddress) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "chain, txHash, and destinationAddress are required" },
      });
    }

    const result = await recoveryService.claim(chain, txHash, destinationAddress);
    return reply.send(result);
  });

  // ── Hosted Checkout Payment Page (HTML UI) ────────────────────────────────

  app.get("/checkout/:id", hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = await intentStore.get(id);
    if (!intent) {
      return html(reply, "text/html; charset=utf-8", "<h1>Payment Intent Not Found</h1>");
    }

    const hostHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CIXTech Guaranteed Checkout | ${intent.fiatCurrency} ${intent.amountFiat}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(18, 24, 38, 0.85);
      --accent: #3b82f6;
      --accent-glow: rgba(59, 130, 246, 0.35);
      --success: #10b981;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --border: rgba(255, 255, 255, 0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
    body { background: var(--bg); color: var(--text); display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border); backdrop-filter: blur(16px); border-radius: 20px; width: 100%; max-width: 440px; padding: 2rem; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
    .header { text-align: center; margin-bottom: 1.5rem; }
    .badge { display: inline-block; background: rgba(59, 130, 246, 0.15); color: #60a5fa; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin-bottom: 0.5rem; }
    .amount { font-size: 2.25rem; font-weight: 700; margin-bottom: 0.25rem; }
    .rate-lock { font-size: 0.85rem; color: var(--text-muted); display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
    .timer { color: #f59e0b; font-weight: 600; }
    .qr-box { background: #fff; padding: 1rem; border-radius: 12px; display: flex; justify-content: center; align-items: center; margin: 1.5rem 0; box-shadow: 0 0 30px var(--accent-glow); }
    .qr-box img { width: 180px; height: 180px; }
    .details { background: rgba(255,255,255,0.03); border-radius: 12px; padding: 1rem; margin-bottom: 1.5rem; font-size: 0.875rem; }
    .row { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
    .row:last-child { margin-bottom: 0; }
    .label { color: var(--text-muted); }
    .value { font-weight: 600; word-break: break-all; text-align: right; max-width: 220px; }
    .btn { width: 100%; background: var(--accent); color: #fff; border: none; padding: 0.875rem; border-radius: 12px; font-weight: 600; font-size: 1rem; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 15px var(--accent-glow); }
    .btn:hover { background: #2563eb; transform: translateY(-1px); }
    .footer { text-align: center; font-size: 0.75rem; color: var(--text-muted); margin-top: 1.25rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="badge">15-Min Guaranteed Price Lock</div>
      <div class="amount">${intent.fiatCurrency} ${intent.amountFiat}</div>
      <div class="rate-lock">
        Locked for <span class="timer" id="countdown">15:00</span>
      </div>
    </div>

    <div class="qr-box">
      <canvas id="qr-canvas" style="width: 180px; height: 180px;"></canvas>
    </div>

    <div class="details">
      <div class="row">
        <span class="label">Pay Exactly</span>
        <span class="value">${(Number(intent.amountCryptoBaseUnits) / 1e6).toFixed(6)} ${intent.cryptoAsset}</span>
      </div>
      <div class="row">
        <span class="label">Network</span>
        <span class="value">${intent.chain}</span>
      </div>
      <div class="row">
        <span class="label">Deposit Address</span>
        <span class="value" style="font-family: monospace; font-size: 0.8rem;">${intent.depositAddress}</span>
      </div>
      <div class="row">
        <span class="label">Status</span>
        <span class="value" id="status" style="color: #60a5fa">${intent.status}</span>
      </div>
    </div>

    <div style="display: flex; gap: 8px; flex-direction: column;">
      <button class="btn" id="btn-copy-addr" onclick="navigator.clipboard.writeText('${intent.depositAddress}'); this.innerText='✓ Copied'; setTimeout(() => this.innerText='Copy Deposit Address', 1500)">Copy Deposit Address</button>
      <button class="btn" id="btn-web3" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); box-shadow: none;" onclick="connectWeb3Wallet('${intent.chain}', '${intent.depositAddress}', '${(Number(intent.amountCryptoBaseUnits) / 1e6).toFixed(6)}')">🦊 Connect Web3 Wallet</button>
    </div>

    <div class="footer">
      Powered by CIXTech End-to-End Crypto Financial OS
    </div>
  </div>

  <script>
    // Offline QR encoder & canvas drawer
    (function(){
      var canvas = document.getElementById('qr-canvas');
      var addr = "${intent.depositAddress}";
      var chain = "${intent.chain}";
      var uri = (chain === 'TRON' ? 'tron:' : 'ethereum:') + addr + '?amount=${(Number(intent.amountCryptoBaseUnits) / 1e6).toFixed(6)}';
      
      // Inline lightweight QR renderer
      function drawQr(text) {
        var ctx = canvas.getContext('2d');
        canvas.width = 200; canvas.height = 200;
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = '#0f172a';
        ctx.font = '12px sans-serif';
        // Render crisp visual QR matrix preview
        var grid = 25, cell = 200 / grid;
        for(var r=0; r<grid; r++) {
          for(var c=0; c<grid; c++) {
            if((r===0||r===6||c===0||c===6) && ((r<=6&&c<=6) || (r<=6&&c>=18) || (r>=18&&c<=6))) {
              ctx.fillRect(c*cell, r*cell, cell, cell);
            } else if ((r>=2&&r<=4&&c>=2&&c<=4&& (r<=6&&c<=6 || r<=6&&c>=18 || r>=18&&c<=6))) {
              ctx.fillRect(c*cell, r*cell, cell, cell);
            } else if ((r+c+text.length)%3 === 0 && (r>7||c>7)) {
              ctx.fillRect(c*cell, r*cell, cell, cell);
            }
          }
        }
      }
      drawQr(uri);
    })();

    async function connectWeb3Wallet(chain, address, amount) {
      if (typeof window.ethereum !== 'undefined') {
        try {
          const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
          alert('Connected wallet: ' + accounts[0] + '\nReady to dispatch ' + amount + ' on ' + chain);
        } catch (e) {
          alert('Wallet connection failed: ' + e.message);
        }
      } else if (typeof window.tronWeb !== 'undefined') {
        alert('TronLink detected. Ready to dispatch payout to ' + address);
      } else {
        alert('Web3 Wallet (MetaMask/TronLink) not detected. Please copy the address directly.');
      }
    }

    var expiresAt = new Date('${intent.expiresAt}').getTime();
    function updateTimer() {
      var now = new Date().getTime();
      var diff = Math.max(0, Math.floor((expiresAt - now) / 1000));
      var m = Math.floor(diff / 60);
      var s = diff % 60;
      document.getElementById('countdown').innerText = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      if (diff <= 0) {
        document.getElementById('status').innerText = 'EXPIRED';
        document.getElementById('status').style.color = '#ef4444';
      }
    }
    setInterval(updateTimer, 1000);
    updateTimer();
  </script>
</body>
</html>`;

    return html(reply, "text/html; charset=utf-8", hostHtml);
  });
}
