/**
 * Shared front-end fragments for the admin console and the tenant portal.
 *
 * Both SPAs are inlined strings served with no build step and no CDN (ADR 0015),
 * so anything they both need lives here rather than being copied into each. The JS
 * avoids template literals so it embeds safely in a TS template string.
 *
 * Three things live here:
 *
 * 1. **Money formatting.** The ledger stores integer base units. A UI that prints
 *    them raw is wrong by 10^decimals — it shows 4.34 USDT as "4,340,000 USDT".
 *    Decimals come from the API (`assets`, sourced from chain-config per §16.5);
 *    an asset the server did not describe is rendered as an explicitly-labelled
 *    base-unit count rather than a plausible-looking wrong number.
 * 2. **Plain-language labels.** Ledger account keys and entry kinds are internal
 *    identifiers (`merchant_available:<tenant>:<account>`, `deposit.finalized`).
 *    Non-technical operators need "Merchant balance" and "Deposit received", with
 *    the raw key still available underneath.
 * 3. **A dependency-free QR encoder** for deposit addresses.
 */

/**
 * The whole visual system for both consoles — a port of egofi's "Gulf of Guinea"
 * design tokens (`@egofi/ui/tailwind-preset`) to plain CSS, so the custody engine
 * and the gateway that fronts it read as one product family.
 *
 * The port keeps egofi's load-bearing idea rather than just its hex codes: **the
 * navy ramp is inverted under dark**, so `--navy-900` means "ink" and
 * `--navy-100` means "hairline" in both themes. Every semantic token below is
 * derived from that ramp through `var()`, which resolves at use time — so one
 * set of component rules serves light and dark with no per-element overrides.
 *
 * Theme resolves in three states, matching egofi: the OS preference by default,
 * overridden by `data-theme` on `<html>` when the operator picks one (persisted
 * in localStorage by `initTheme()` in the JS half).
 *
 * Each SPA supplies only its accent hue — admin takes primary blue, the tenant
 * portal takes info sky — so the two stay distinguishable inside one system
 * without being able to drift apart.
 */
export const UI_KIT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

/* ── Egofi tokens: light ──────────────────────────────────────────────────── */
:root{
  color-scheme:light;
  --navy-50:241 245 250;   --navy-100:225 233 243; --navy-200:195 211 231;
  --navy-300:147 174 207;  --navy-400:91 128 176;  --navy-500:55 93 146;
  --navy-600:37 68 117;    --navy-700:24 50 92;    --navy-800:14 36 73;
  --navy-900:7 28 61;      --navy-950:4 15 38;
  --surface:255 255 255; --surface-raised:255 255 255; --canvas:246 248 252;

  --primary:29 78 216; --info:14 165 233; --accent-lime:163 230 53;
  --success:74 222 128; --warning:245 158 11; --danger-rgb:251 113 133;

  /* "ink" = the readable-on-this-background form of each hue. Only these flip. */
  --primary-ink:29 78 216; --info-ink:2 132 199;  --lime-ink:63 98 18;
  --success-ink:22 101 52; --warning-ink:180 83 9; --danger-ink:190 18 60;

  --shadow-tint:7 28 61;
  --sidebar-fg:226 235 247;
}

/* ── Egofi tokens: dark (the ramp inverts; hues brighten) ─────────────────── */
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    color-scheme:dark;
    --navy-50:22 34 54;     --navy-100:30 45 70;    --navy-200:44 62 92;
    --navy-300:92 114 147;  --navy-400:122 144 177; --navy-500:150 170 200;
    --navy-600:178 195 220; --navy-700:200 214 234; --navy-800:216 228 243;
    --navy-900:233 240 249; --navy-950:244 248 252;
    --surface:17 28 47; --surface-raised:24 37 60; --canvas:8 18 33;
    --primary-ink:96 165 250; --info-ink:56 189 248;  --lime-ink:163 230 53;
    --success-ink:74 222 128; --warning-ink:251 191 36; --danger-ink:251 113 133;
    --shadow-tint:2 6 16;
  }
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --navy-50:22 34 54;     --navy-100:30 45 70;    --navy-200:44 62 92;
  --navy-300:92 114 147;  --navy-400:122 144 177; --navy-500:150 170 200;
  --navy-600:178 195 220; --navy-700:200 214 234; --navy-800:216 228 243;
  --navy-900:233 240 249; --navy-950:244 248 252;
  --surface:17 28 47; --surface-raised:24 37 60; --canvas:8 18 33;
  --primary-ink:96 165 250; --info-ink:56 189 248;  --lime-ink:163 230 53;
  --success-ink:74 222 128; --warning-ink:251 191 36; --danger-ink:251 113 133;
  --shadow-tint:2 6 16;
}

/* Surfaces that are ALWAYS dark (the sidebar) pin the ramp to its light values,
   exactly as egofi's \`.on-dark\` does: there, low-index navy is light ink on a
   dark ground and must not invert. */
.on-dark{
  --navy-50:241 245 250;   --navy-100:225 233 243; --navy-200:195 211 231;
  --navy-300:147 174 207;  --navy-400:91 128 176;  --navy-500:55 93 146;
  --navy-600:37 68 117;    --navy-700:24 50 92;    --navy-800:14 36 73;
  --navy-900:7 28 61;      --navy-950:4 15 38;
}

/* ── Semantics, derived from the ramp (resolved at use time, so they flip) ── */
:root{
  --bg:rgb(var(--canvas));
  --panel:rgb(var(--surface));
  --panel2:rgb(var(--navy-50));
  --raised:rgb(var(--surface-raised));
  --fg:rgb(var(--navy-950));
  --fg2:rgb(var(--navy-700));
  --muted:rgb(var(--navy-500));
  --faint:rgb(var(--navy-400));
  --line:rgb(var(--navy-100));
  --line2:rgb(var(--navy-200));

  --cyan:rgb(var(--primary-ink));
  --purple:rgb(var(--info-ink));
  --green:rgb(var(--success-ink));
  --orange:rgb(var(--warning-ink));
  --ok:rgb(var(--success-ink));   --ok-bg:color-mix(in srgb,rgb(var(--success)) 16%,transparent);
  --warn:rgb(var(--warning-ink)); --warn-bg:color-mix(in srgb,rgb(var(--warning)) 16%,transparent);
  --bad:rgb(var(--danger-ink));   --bad-bg:color-mix(in srgb,rgb(var(--danger-rgb)) 16%,transparent);

  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --display:var(--sans);

  /* Flat / square, per egofi's borderRadius override. \`--r-pill\` is kept so
     genuine circles and pill badges stay round rather than becoming squares. */
  --r:0; --r-sm:0; --r-pill:9999px;

  --shadow-xs:0 1px 2px 0 rgb(var(--shadow-tint) / 0.04);
  --shadow-card:0 1px 2px 0 rgb(var(--shadow-tint) / 0.04),0 6px 20px -6px rgb(var(--shadow-tint) / 0.10);
  --shadow-card-hover:0 2px 4px 0 rgb(var(--shadow-tint) / 0.06),0 14px 32px -8px rgb(var(--shadow-tint) / 0.16);
  --shadow:0 24px 60px -16px rgb(var(--shadow-tint) / 0.28);
  --accent-glow:color-mix(in srgb,var(--accent) 22%,transparent);
  --glass-border:1px solid rgb(var(--navy-100));

  --brand-gradient:radial-gradient(120% 120% at 0% 0%,#0E2449 0%,#071C3D 45%,#040F26 100%);
  --brand-mesh:radial-gradient(60% 40% at 100% 0%,rgba(29,78,216,0.05) 0%,transparent 60%),
               radial-gradient(50% 40% at 0% 8%,rgba(14,165,233,0.05) 0%,transparent 55%);
}

*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background-color:var(--bg);background-image:var(--brand-mesh);background-attachment:fixed;
  color:var(--fg);font:14px/1.6 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  font-feature-settings:"cv02","cv03","cv04","cv11","ss01"}
a{color:var(--accent-ink,var(--accent));text-decoration:none;transition:color .15s}
a:hover{color:var(--accent-hi)}
h1,h2,h3,h4{font-family:var(--display);letter-spacing:-.02em;color:rgb(var(--navy-950))}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

@keyframes fadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
@keyframes pulseDot { 0%,100%{opacity:1} 50%{opacity:.45} }
@keyframes shimmer { 100%{transform:translateX(100%)} }

/* ── Controls ────────────────────────────────────────────────────────────── */
/* \`.button\` rides along so an <a> that acts as a button (the block-explorer
   link) is not left as bare underlined text. */
button,.button{font:500 14px/1.2 var(--sans);cursor:pointer;height:36px;padding:0 16px;
  background:var(--panel);color:rgb(var(--navy-800));border:1px solid rgb(var(--navy-200));
  border-radius:var(--r-sm);box-shadow:var(--shadow-xs);white-space:nowrap;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  transition:background .15s,box-shadow .15s,border-color .15s,transform .1s}
button:hover,.button:hover{background:rgb(var(--navy-50));border-color:rgb(var(--navy-300))}
button:active,.button:active{transform:scale(.98)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
button.primary,.button.primary{background:var(--accent);color:var(--accent-fg,#fff);border-color:transparent;font-weight:600;
  box-shadow:0 1px 3px 0 rgb(var(--shadow-tint) / 0.20)}
button.primary:hover,.button.primary:hover{background:var(--accent-hi);box-shadow:0 4px 12px -2px var(--accent-glow)}
button.danger{background:transparent;border-color:color-mix(in srgb,var(--bad) 40%,transparent);color:var(--bad)}
button.danger:hover{background:var(--bad-bg);border-color:var(--bad)}
input,select,textarea{font:14px var(--sans);background:var(--panel);border:1px solid rgb(var(--navy-200));
  color:var(--fg);border-radius:var(--r-sm);padding:8px 12px;height:36px;transition:border-color .15s,box-shadow .15s}
textarea{height:auto}
input:hover,select:hover,textarea:hover{border-color:rgb(var(--navy-300))}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
input::placeholder,textarea::placeholder{color:var(--faint)}

/* ── Top bar ─────────────────────────────────────────────────────────────── */
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 28px;
  background:color-mix(in srgb,var(--panel) 82%,transparent);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line);position:sticky;top:0;z-index:40;margin-bottom:24px;flex-wrap:wrap}
.topbar-left{display:flex;align-items:center;gap:16px}
.status-pill{display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border-radius:var(--r-pill);
  background:var(--ok-bg);border:1px solid color-mix(in srgb,rgb(var(--success)) 35%,transparent);
  font-size:12px;font-weight:500;color:var(--ok)}
.status-dot{width:6px;height:6px;border-radius:var(--r-pill);background:currentColor;animation:pulseDot 2s infinite ease-in-out}
.top-search{position:relative;width:240px}
.top-search input{width:100%;padding-left:32px;font-size:13px;height:34px}
.theme-toggle{width:32px;height:32px;padding:0;font-size:14px;flex:none}

/* ── Timeframe filter & timezone chip ────────────────────────────────────── */
.timeframe-group{display:inline-flex;gap:2px;background:rgb(var(--navy-50));padding:3px;border:1px solid var(--line)}
.tf-btn{height:28px;padding:0 12px;font-size:12.5px;font-weight:500;border:1px solid transparent;
  background:transparent;color:var(--muted);box-shadow:none}
.tf-btn:hover{color:var(--fg);background:color-mix(in srgb,var(--panel) 70%,transparent);border-color:transparent}
.tf-btn.active{background:var(--panel);border-color:rgb(var(--navy-200));color:var(--accent-ink,var(--accent));
  font-weight:600;box-shadow:var(--shadow-xs)}
.tz-badge{display:inline-flex;align-items:center;gap:6px;padding:0 12px;height:34px;
  background:rgb(var(--navy-50));border:1px solid var(--line);font-size:12.5px;color:var(--muted)}

/* ── Sign-in ─────────────────────────────────────────────────────────────── */
.login{max-width:400px;margin:12vh auto;padding:36px;background:var(--panel);
  border:1px solid var(--line);box-shadow:var(--shadow);animation:fadeIn .3s cubic-bezier(0.22,1,0.36,1) both}
.login .mark{width:42px;height:42px;margin-bottom:18px;background:var(--brand-gradient);
  display:flex;align-items:center;justify-content:center;color:rgb(var(--accent-lime));
  font-weight:800;font-size:20px}
.login h1{font-size:1.75rem;line-height:2.125rem;letter-spacing:-.02em;margin:0 0 6px;font-weight:700}
.login p{color:var(--muted);margin:0 0 22px;font-size:13.5px;line-height:1.55}
.login input{width:100%;margin-bottom:14px}
.login button{width:100%;height:44px}
.err{color:var(--bad);font-size:13px;min-height:18px;margin-top:10px}

/* ── Shell & sidebar ─────────────────────────────────────────────────────── */
.shell{display:grid;grid-template-columns:250px 1fr;min-height:100vh}
.side{background:var(--brand-gradient);border-right:1px solid rgba(255,255,255,0.06);padding:20px 14px;
  display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto;
  color:var(--sidebar-fg)}
.brand{display:flex;align-items:center;gap:12px;padding:6px 10px 22px}
.brand .mark{width:36px;height:36px;flex:none;background:rgb(var(--accent-lime));
  display:flex;align-items:center;justify-content:center;color:#1A2E05;font-weight:800;font-size:17px}
.brand b{display:block;font-size:15px;font-weight:700;letter-spacing:-.01em;line-height:1.25;color:#fff}
.brand small{display:block;color:rgba(226,235,247,0.62);font-weight:400;font-size:11px;line-height:1.3}

.nav-group-title{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;
  padding:16px 12px 6px;color:rgba(226,235,247,0.45)}

.nav{display:flex;align-items:center;gap:11px;padding:9px 12px;color:rgba(226,235,247,0.78);
  cursor:pointer;font-size:13.5px;font-weight:500;user-select:none;
  border-left:2px solid transparent;transition:background .15s,color .15s}
.nav svg{width:18px;height:18px;flex:none;opacity:.75}
.nav:hover{background:rgba(255,255,255,0.06);color:#fff}
.nav:hover svg{opacity:1}
.nav.active{background:rgba(255,255,255,0.10);color:#fff;border-left-color:rgb(var(--accent-lime));font-weight:600}
.nav.active svg{opacity:1;color:rgb(var(--accent-lime))}

.side .spacer{flex:1}
.side button{background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.14);color:rgba(226,235,247,0.9);box-shadow:none}
.side button:hover{background:rgba(255,255,255,0.13);border-color:rgba(255,255,255,0.22);color:#fff}
.side-foot{border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;margin-top:12px;
  display:flex;align-items:center;gap:8px;flex-wrap:nowrap}
.side-foot .spacer{flex:1;min-width:0}
.side-foot-item{display:flex;align-items:center;gap:6px;font-size:11.5px;color:rgba(226,235,247,0.6)}
.side-foot-item .dot{width:6px;height:6px;border-radius:var(--r-pill)}
.side-foot-item .dot.blue{background:#38BDF8}
.side-foot-item .dot.green{background:rgb(var(--success))}
.env-pill{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:3px 10px;
  border-radius:var(--r-pill);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;
  background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.4);color:rgb(var(--success))}
.env-pill.testnet{background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.45);color:#FBBF24}

/* The gutter lives on the scroll container, not on one named child: the admin
   console writes screens straight into \`.main\` while the portal wraps them in
   \`#content-body\`, and hanging the padding off the wrapper left admin's cards
   running under the sidebar and off the right edge. \`.topbar\` opts back out
   because it is a full-bleed sticky bar. */
/* The gutter lives on the scroll container, so every screen gets it whichever
   way its console renders: the admin console writes straight into \`.main\`, the
   portal wraps its screens in \`#content-body\`. Hanging it off the wrapper left
   admin's cards flush against the sidebar and clipped off the right edge, and
   padding the children instead only insets their text — a panel or banner has a
   background, so its box would still have run edge to edge.
   The sticky topbar cancels the gutter back out, since it is full-bleed. */
.main{padding:0 34px 60px;overflow:auto;min-width:0}
.main>.topbar{margin-left:-34px;margin-right:-34px}
#content-body{padding:0}
/* Long lines are unreadable on an ultrawide, so content stops widening before
   the window does. */
.main>*:not(.topbar),#content-body>*{max-width:1560px}
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;
  margin:6px 0 24px;flex-wrap:wrap;animation:fadeIn .4s cubic-bezier(0.22,1,0.36,1) both}
.head h2{margin:0;font-size:1.75rem;line-height:2.125rem;letter-spacing:-.02em;font-weight:700}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}

/* ── Metric cards ────────────────────────────────────────────────────────── */
.nexis-cards,.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.nexis-card,.card{background:var(--panel);border:1px solid color-mix(in srgb,rgb(var(--navy-100)) 80%,transparent);
  padding:20px 22px;box-shadow:var(--shadow-card);position:relative;overflow:hidden;
  transition:box-shadow .2s,transform .2s,border-color .2s;animation:fadeIn .4s cubic-bezier(0.22,1,0.36,1) both}
.nexis-card:hover,.card:hover{transform:translateY(-2px);box-shadow:var(--shadow-card-hover);border-color:rgb(var(--navy-200))}
/* A 2px hue rule along the top edge is the only colour a card carries — the
   surface itself stays neutral so a wall of cards does not read as a rainbow. */
.nexis-card::before{content:'';position:absolute;inset:0 0 auto 0;height:2px;background:var(--card-hue,transparent)}
.nexis-card.orders,.nexis-card.cyan{--card-hue:rgb(var(--primary))}
.nexis-card.amount,.nexis-card.green{--card-hue:rgb(var(--success))}
.nexis-card.currencies,.nexis-card.purple{--card-hue:rgb(var(--info))}
.nexis-card.blockchains,.nexis-card.orange{--card-hue:rgb(var(--warning))}
.nexis-card.bad{--card-hue:rgb(var(--danger-rgb))}

.nexis-card-head{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:11.5px;
  font-weight:600;text-transform:uppercase;letter-spacing:.7px;margin-bottom:10px}
.nexis-card-head .icon-box{width:26px;height:26px;display:flex;align-items:center;justify-content:center;
  background:rgb(var(--navy-50));border:1px solid var(--line);font-size:14px}
.nexis-card-val,.card .v{font-size:1.75rem;line-height:2.125rem;font-weight:700;font-family:var(--display);
  font-variant-numeric:tabular-nums;letter-spacing:-.025em;color:rgb(var(--navy-950));margin-bottom:6px}
.card .k{color:var(--muted);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}

.nexis-sub-item{margin-top:8px;font-size:12.5px;line-height:1.4}
.nexis-sub-title{font-weight:600;display:flex;align-items:center;gap:6px;color:rgb(var(--navy-800))}
.nexis-sub-title.cyan{color:var(--cyan)}
.nexis-sub-title.orange{color:var(--orange)}
.nexis-sub-desc{color:var(--faint);font-size:11.5px;margin-top:2px}

/* ── Panels & tables ─────────────────────────────────────────────────────── */
.panel{background:var(--panel);border:1px solid color-mix(in srgb,rgb(var(--navy-100)) 80%,transparent);
  overflow:hidden;margin-bottom:24px;box-shadow:var(--shadow-card);
  animation:fadeIn .4s cubic-bezier(0.22,1,0.36,1) both}
.panel h3{margin:0;padding:15px 20px;font-size:12.5px;color:rgb(var(--navy-700));font-weight:600;
  border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.7px;background:rgb(var(--navy-50))}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:12px 20px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.6px;
  background:rgb(var(--navy-50));position:sticky;top:0;z-index:1;white-space:nowrap}
tbody tr{transition:background .15s}
tbody tr:hover{background:rgb(var(--navy-50) / 0.6)}
tbody tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.mono,.mono{font-family:var(--mono);font-size:12px}
.muted{color:var(--muted)}
.actions{white-space:nowrap}
.actions button{height:28px;padding:0 10px;font-size:12.5px;margin-left:6px}
.actions button:first-child{margin-left:0}
.empty{padding:34px 26px;text-align:center;color:var(--muted);font-size:13.5px}
.hint{color:var(--muted);font-size:12.5px;padding:12px 20px;margin:0;border-top:1px solid var(--line);line-height:1.55}
.panel>.hint:first-child{border-top:none}

/* ── Badges ──────────────────────────────────────────────────────────────── */
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:var(--r-pill);
  font-size:12px;font-weight:500;border:1px solid transparent;white-space:nowrap;line-height:1.5}
.badge.ok{color:var(--ok);background:var(--ok-bg);border-color:color-mix(in srgb,rgb(var(--success)) 35%,transparent)}
.badge.warn{color:var(--warn);background:var(--warn-bg);border-color:color-mix(in srgb,rgb(var(--warning)) 35%,transparent)}
.badge.bad{color:var(--bad);background:var(--bad-bg);border-color:color-mix(in srgb,rgb(var(--danger-rgb)) 35%,transparent)}
.badge.muted{color:rgb(var(--navy-700));background:rgb(var(--navy-50));border-color:var(--line2)}
.ai-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:var(--r-pill);
  font-size:12px;font-weight:500;background:color-mix(in srgb,rgb(var(--info)) 14%,transparent);
  border:1px solid color-mix(in srgb,rgb(var(--info)) 32%,transparent);color:var(--purple)}

/* ── Banners ─────────────────────────────────────────────────────────────── */
.banner{padding:12px 16px;margin-bottom:18px;font-weight:400;font-size:13.5px;border:1px solid;line-height:1.5}
.banner.ok{background:var(--ok-bg);border-color:color-mix(in srgb,rgb(var(--success)) 35%,transparent);color:var(--ok)}
.banner.warn{background:var(--warn-bg);border-color:color-mix(in srgb,rgb(var(--warning)) 38%,transparent);color:var(--warn)}
.banner.bad{background:var(--bad-bg);border-color:color-mix(in srgb,rgb(var(--danger-rgb)) 38%,transparent);color:var(--bad)}

/* ── Money + account cells ───────────────────────────────────────────────── */
.amount{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:500}
.amount .sym{color:var(--muted);font-size:.82em;margin-left:4px;font-weight:400}
.pos,.neg{color:var(--fg)}
/* The name and the raw key are separate LINES. Both are spans, so they need an
   explicit block — inline is what made them collide into one run of text. */
.acct{display:block;min-width:0}
.acct .name{display:block;font-weight:500;line-height:1.35}
.acct .sub{display:block;color:var(--faint);font-family:var(--mono);font-size:10.5px;
  line-height:1.4;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34ch}
.movement{display:flex;align-items:baseline;gap:10px;padding:3px 0}
.movement .dir{color:var(--muted);font-size:11px;min-width:32px;text-transform:uppercase;
  letter-spacing:.4px;font-weight:600}
.movement .amt{min-width:118px;text-align:right}

/* ── Journal entries ─────────────────────────────────────────────────────── */
/* A journal entry is ONE event with several postings, and it used to render as
   several free-floating lines whose amounts, directions and account names never
   lined up — three columns of drift per row. Everything now sits on one grid,
   so amounts share a right edge and account names share a left one no matter
   how many postings an entry carries. */
/* The event column sizes to its content so the postings take the slack, instead
   of the old four-column split where the two narrow columns took it. */
.col-event{width:1%;white-space:nowrap;vertical-align:top;padding-top:16px}
.entry-what{display:flex;flex-direction:column;gap:5px;align-items:flex-start}
.entry-meta{display:flex;align-items:center;gap:7px;flex-wrap:nowrap;color:var(--faint);font-size:11.5px}
.entry-meta .ref{font-family:var(--mono);font-size:11px}
.entry-meta .sep{opacity:.5}

.flow{display:grid;grid-template-columns:minmax(96px,auto) auto minmax(0,1fr);
  gap:2px 14px;align-items:baseline}
.flow-amt{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The direction chip is what tells a reader which way value moved; as 11px grey
   caps it was the least visible thing in the row despite being the point. */
.flow-dir{justify-self:start;font-size:10.5px;font-weight:600;text-transform:uppercase;
  letter-spacing:.5px;padding:1px 7px;border-radius:var(--r-pill);border:1px solid transparent;white-space:nowrap}
.flow-dir.in{color:var(--ok);background:var(--ok-bg);border-color:color-mix(in srgb,rgb(var(--success)) 30%,transparent)}
.flow-dir.out{color:var(--warn);background:var(--warn-bg);border-color:color-mix(in srgb,rgb(var(--warning)) 30%,transparent)}
/* \`display:contents\` dissolves the row wrapper so its three spans become grid
   items of \`.flow\` itself — that is what keeps every posting on the same three
   columns without a subgrid. */
.flow-row{display:contents}
.flow-row.lead>*{padding-bottom:7px}
.flow-row.lead .flow-amt{font-size:15px;font-weight:600;color:rgb(var(--navy-950))}
.flow-row.lead .acct .name{font-weight:600}
/* The lead posting is the event's headline; the rest are the split it was
   broken into. The hairline runs across all three columns, so the grouping is
   structural rather than something the reader has to infer. */
.flow-row.split-start>*{border-top:1px dashed var(--line2);padding-top:8px}
.flow-row.split>*{padding-block:2px}
.flow-row.split .flow-amt{font-size:13px;color:var(--fg2)}
.flow-row.split .acct .name{color:var(--fg2);font-weight:400}

/* ── Forms ───────────────────────────────────────────────────────────────── */
.form{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;padding:16px 20px}
.form label{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--muted);
  font-weight:600;text-transform:uppercase;letter-spacing:.4px}

/* ── Modal ───────────────────────────────────────────────────────────────── */
.modal-back{position:fixed;inset:0;background:rgb(var(--navy-950) / 0.55);backdrop-filter:blur(3px);
  display:flex;align-items:center;justify-content:center;padding:20px;z-index:50;animation:fade .14s ease-out}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(10px) scale(.995)}to{opacity:1;transform:none}}
.modal{background:var(--panel);border:1px solid var(--line2);max-width:580px;width:100%;
  max-height:90vh;overflow:auto;box-shadow:var(--shadow);animation:rise .2s cubic-bezier(0.22,1,0.36,1)}
.modal header{padding:17px 20px;border-bottom:1px solid var(--line);display:flex;
  align-items:center;justify-content:space-between;gap:12px}
.modal header h3{margin:0;font-size:1.125rem;font-weight:600;letter-spacing:-.01em}
.modal .body{padding:20px}
.modal .body h4{margin:0 0 8px;font-size:13px;font-weight:600}
.modal .foot{padding:15px 20px;border-top:1px solid var(--line);display:flex;gap:10px;
  justify-content:flex-end;flex-wrap:wrap;background:rgb(var(--navy-50))}
.modal .x{background:none;border:none;color:var(--muted);font-size:22px;line-height:1;
  height:28px;width:28px;padding:0;box-shadow:none}
.modal .x:hover{background:rgb(var(--navy-100));color:var(--fg)}
.modal .hint{border-top:none;padding:10px 0 0}
.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;align-items:baseline;margin:0 0 18px}
.kv dt{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.kv dd{margin:0;font-family:var(--mono);font-size:12.5px;word-break:break-all}
.faq{margin-bottom:8px;background:rgb(var(--navy-50));border:1px solid var(--line);padding:8px 12px}
.faq summary{cursor:pointer;font-weight:600;color:var(--accent-ink,var(--accent))}
.faq p{margin:6px 0 0;color:rgb(var(--navy-700))}
.secretbox{background:rgb(var(--navy-50));border:1px dashed color-mix(in srgb,rgb(var(--warning)) 60%,transparent);
  padding:13px 14px;font-family:var(--mono);font-size:12.5px;word-break:break-all;
  margin:8px 0 4px;line-height:1.6;color:var(--warn)}
.warnnote{color:var(--warn);font-size:12px;margin:0 0 6px;font-weight:600;
  text-transform:uppercase;letter-spacing:.5px}
.detail{background:rgb(var(--navy-50));border:1px solid var(--line2);padding:14px;margin:0 20px 20px;
  white-space:pre-wrap;word-break:break-all;font-family:var(--mono);font-size:12px;
  line-height:1.6;max-height:340px;overflow:auto}

/* ── Deposit-address sheet ───────────────────────────────────────────────── */
.qrwrap{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
.qrbox{background:#fff;padding:12px;line-height:0;flex:none;border:1px solid var(--line2)}
.qrbox canvas{display:block;width:184px;height:184px;image-rendering:pixelated}
.qrside{flex:1;min-width:230px}
.addr{font-family:var(--mono);font-size:12.5px;word-break:break-all;background:rgb(var(--navy-50));
  border:1px solid var(--line2);padding:11px 13px;margin-bottom:12px;line-height:1.6;user-select:all}
.btnrow{display:flex;gap:8px;flex-wrap:wrap}
.btnrow button{height:32px;padding:0 12px;font-size:12.5px}

/* ── Activity chart ──────────────────────────────────────────────────────── */
.chart-panel{background:var(--panel);border:1px solid color-mix(in srgb,rgb(var(--navy-100)) 80%,transparent);
  padding:20px 22px;margin-bottom:24px;box-shadow:var(--shadow-card)}
.chart-header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.chart-header h3{margin:0;font-size:14px;font-weight:600}
.chart-legend{display:flex;gap:14px;flex-wrap:wrap}
.legend-item{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.legend-dot{width:8px;height:8px;border-radius:var(--r-pill);flex:none}
.stacked-bars-container{display:flex;align-items:flex-end;justify-content:space-around;gap:12px;height:170px}
.bar-col{display:flex;flex-direction:column;align-items:center;gap:8px;flex:1;min-width:0}
.bar-stack{display:flex;flex-direction:column;justify-content:flex-end;width:100%;max-width:44px;height:140px}
.bar-seg{width:100%;transition:opacity .15s}
.bar-seg:hover{opacity:.75}
.bar-seg.payments{background:rgb(var(--success))}
.bar-seg.donations{background:rgb(var(--warning))}
.bar-seg.pending{background:rgb(var(--primary))}
.bar-seg.partial{background:rgb(var(--accent-lime))}
.bar-seg.expired{background:rgb(var(--navy-300))}
.bar-label{font-size:11.5px;color:var(--muted);font-weight:500}

/* ── Toasts ──────────────────────────────────────────────────────────────── */
.toast-container{position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;
  flex-direction:column;gap:8px;pointer-events:none}
.toast{background:rgb(var(--navy-950));color:rgb(var(--surface));padding:11px 18px;font-size:13.5px;
  box-shadow:var(--shadow);display:flex;align-items:center;gap:10px;
  animation:toastIn .22s cubic-bezier(0.22,1,0.36,1)}
@keyframes toastIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}

@media (max-width:820px){
  .shell{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;
    border-right:none;border-bottom:1px solid rgba(255,255,255,0.08);padding:10px 12px}
  .brand{padding:0 12px 0 4px}
  .side .spacer{flex:0}
  .side-foot{border-top:none;margin-top:0;padding-top:0;flex-direction:row;align-items:center;gap:12px}
  .nav{border-left:none;border-bottom:2px solid transparent}
  .nav.active{border-left-color:transparent;border-bottom-color:rgb(var(--accent-lime))}
  .topbar{padding:12px 16px}
  #content-body,.main>.head{padding-left:16px;padding-right:16px}
  th,td{padding:10px 12px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;
    transition-duration:.01ms !important}
}
@media print{
  body{background:#fff;color:#000}
  .side,.topbar,.head button,.btnrow,.modal .foot,.nav{display:none !important}
  .modal-back{position:static;background:none;padding:0;backdrop-filter:none}
  .modal{border:none;box-shadow:none;max-width:none;max-height:none;animation:none}
  .qrbox{border:1px solid #ccc}
  .addr{background:none;border:1px solid #ccc;color:#000}
}
`;

export const UI_KIT_JS = String.raw`
// ── Money, labels, and shared console components ─────────────────────────

/**
 * Theme resolution, matching egofi's three states: no attribute means "follow
 * the OS", and an explicit choice stamps data-theme on <html> so the CSS
 * override blocks win in both directions. Persisted per console.
 */
function initTheme(){
  var saved=null;
  try{saved=localStorage.getItem('cx_theme');}catch(e){}
  if(saved==='dark'||saved==='light')document.documentElement.setAttribute('data-theme',saved);
}
function currentTheme(){
  var attr=document.documentElement.getAttribute('data-theme');
  if(attr)return attr;
  return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
}
function toggleTheme(){
  var next=currentTheme()==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',next);
  try{localStorage.setItem('cx_theme',next);}catch(e){}
  render();
}

var ASSETS={};
/** Cache the API's asset table (symbol → decimals). Call before formatting money. */
function setAssets(list){ASSETS={};for(var i=0;i<(list||[]).length;i++){var a=list[i];ASSETS[String(a.symbol).toUpperCase()]=a;}}
function assetInfo(sym){return ASSETS[String(sym==null?'':sym).toUpperCase()]||null;}

function renderStatGrid(cards){
  var h = '<div class="nexis-cards">';
  for(var i=0; i<(cards||[]).length; i++){
    var c = cards[i];
    var title = c.title || c[0] || '';
    var val = c.value || c[1] || '0';
    var sub = c.sub || c[2] || '';
    var icon = c.icon || c[3] || '📈';
    var color = c.color || c[4] || (i===0?'cyan':i===1?'green':i===2?'purple':'orange');
    h += '<div class="nexis-card '+color+'">'+
      '<div class="nexis-card-head"><div class="icon-box">'+icon+'</div><span>'+esc(title)+'</span></div>'+
      '<div class="nexis-card-val">'+(typeof val==='string'&&val.indexOf('<')!==-1?val:esc(String(val)))+'</div>'+
      // The caption stays muted. It was tinted to match the card's hue, which
      // put four different colours of small text on one row and made the least
      // important line the loudest — the hue already lives on the rule and icon.
      (sub?'<div class="nexis-sub-desc">'+(typeof sub==='string'&&sub.indexOf('<')!==-1?sub:esc(String(sub)))+'</div>':'')+
    '</div>';
  }
  h += '</div>';
  return h;
}

/**
 * One journal entry's postings, laid on a single three-column grid.
 *
 * The debit — where value landed — leads, and the credits it was split into sit
 * beneath a hairline. Every posting is still shown with its own direction and
 * amount; this only groups them, because a deposit that credits a merchant and
 * a fee account is one event, not three unrelated lines.
 *
 * An entry with no debit (or only one posting) degrades to a flat list rather
 * than inventing a headline.
 */
function renderFlow(postings){
  var list=postings||[];
  var lead=-1;
  for(var i=0;i<list.length;i++){ if(list[i].direction==='DEBIT'){lead=i;break;} }

  // "into"/"from" is the ledger's existing plain-language vocabulary for a debit
  // and a credit — the layout is what was wrong here, not the wording.
  var cell=function(p,cls){
    var into=p.direction==='DEBIT';
    return '<div class="flow-row '+cls+'">'+
      '<span class="flow-amt amount">'+moneyHtml(p.amount,p.asset)+'</span>'+
      '<span class="flow-dir '+(into?'in':'out')+'">'+(into?'into':'from')+'</span>'+
      accountCell(p.account)+'</div>';
  };

  var h='<div class="flow">';
  if(lead>=0&&list.length>1){
    h+=cell(list[lead],'lead');
    var first=true;
    for(var j=0;j<list.length;j++){
      if(j===lead)continue;
      h+=cell(list[j],'split'+(first?' split-start':''));
      first=false;
    }
  }else{
    for(var k=0;k<list.length;k++)h+=cell(list[k],k===0?'lead':'split'+(k===1?' split-start':''));
  }
  return h+'</div>';
}

/**
 * The event column: what happened, then when and against which reference. These
 * were three separate table columns, which left two of them almost empty and
 * pushed the reference so far right it read as unrelated to its own row.
 */
function renderEventCell(label, cls, when, ref){
  return '<div class="entry-what"><span class="badge '+cls+'">'+esc(label)+'</span>'+
    '<div class="entry-meta">'+(when||'')+
    (ref?'<span class="sep">·</span><span class="ref" title="'+esc(ref)+'">'+esc(short(ref))+'</span>':'')+
    '</div></div>';
}

function renderTimeframeSwitcher(active){
  active=active||'7 Days';
  var list=['Today','7 Days','30 Days','All Time'];
  var h='<div class="row"><div class="timeframe-group">';
  for(var i=0;i<list.length;i++){
    h+='<button class="tf-btn'+(list[i]===active?' active':'')+'" onclick="window.setTimeframe&&window.setTimeframe(\''+list[i]+'\')">'+list[i]+'</button>';
  }
  // Timestamps render as UTC throughout (see when()), so the chip states that
  // rather than guessing at an offset.
  h+='</div><div class="tz-badge">🌐 UTC</div></div>';
  return h;
}

/**
 * The sidebar foot carries only what the page can actually observe. It used to
 * print an uptime, a CPU percentage and a MAINNET pill that were all string
 * literals — a console for a custody engine is the last place to show a number
 * nobody measured. Environment comes from the API (setEngineEnv) and is simply
 * absent until it answers.
 */
var ENGINE_ENV=null;
function setEngineEnv(env){ENGINE_ENV=env?String(env):null;}
function renderSidebarFooter(){
  var envPill=ENGINE_ENV
    ? '<div class="env-pill'+(/test|dev/i.test(ENGINE_ENV)?' testnet':'')+'"><span class="status-dot"></span><span>'+esc(ENGINE_ENV)+'</span></div>'
    : '';
  var dark=currentTheme()==='dark';
  // One row rather than three stacked blocks: status and environment belong
  // together (both answer "what am I looking at?"), and the toggle is an action,
  // so it sits apart on the right.
  return '<div class="side-foot">'+
    '<div class="side-foot-item"><span class="dot green"></span><span>connected</span></div>'+
    envPill+
    '<div class="spacer"></div>'+
    '<button class="theme-toggle" onclick="toggleTheme()" title="Switch to '+(dark?'light':'dark')+' theme" aria-label="Switch to '+(dark?'light':'dark')+' theme">'+(dark?'☀️':'🌙')+'</button>'+
    '</div>';
}

/**
 * The overview's four headline cards. The vocabulary is the engine's — movements,
 * deposits, payouts, held balances, assets, chains. It previously read "TOTAL
 * ORDERS" and "payouts / donations", which are a merchant's words for a
 * merchant's product; per ADR 0017 the engine does not have orders.
 *
 * A card renders only when its caller supplies a value, so a console that cannot
 * answer "how many chains" shows three cards rather than a confident zero.
 */
function renderNexisCards(opts){
  opts=opts||{};
  var card=function(cls,icon,title,val,subs){
    var h='<div class="nexis-card '+cls+'">'+
      '<div class="nexis-card-head"><div class="icon-box">'+icon+'</div><span>'+esc(title)+'</span></div>'+
      '<div class="nexis-card-val">'+esc(String(val))+'</div>';
    for(var i=0;i<(subs||[]).length;i++){
      var s=subs[i];
      h+='<div class="nexis-sub-item"><div class="nexis-sub-title '+s.hue+'">'+esc(s.title)+'</div>'+
         (s.desc?'<div class="nexis-sub-desc">'+esc(s.desc)+'</div>':'')+'</div>';
    }
    return h+'</div>';
  };

  var out='';
  if(opts.movements!=null){
    out+=card('cyan','📊','LEDGER MOVEMENTS',opts.movements,[
      {hue:'cyan',title:(opts.depositCount||'0')+' deposits',desc:opts.depositSub||''},
      {hue:'orange',title:(opts.payoutCount||'0')+' payouts',desc:opts.payoutSub||''}
    ]);
  }
  if(opts.held!=null){
    out+=card('green','💲','HELD FOR CUSTOMERS',opts.held,[
      {hue:'cyan',title:(opts.inflow||'0')+' in',desc:''},
      {hue:'orange',title:(opts.outflow||'0')+' out',desc:''}
    ]);
  }
  if(opts.assets!=null){
    out+=card('purple','👛','ASSETS',opts.assets,[{hue:'',title:'Supported by this deployment',desc:''}]);
  }
  if(opts.chains!=null){
    out+=card('orange','📦','CHAINS',opts.chains,[{hue:'',title:'Routed by this deployment',desc:''}]);
  }
  return '<div class="nexis-cards">'+out+'</div>';
}

function buildDailyActivity(deposits, payouts){
  var map={Mon:{pay:0,don:0,pend:0,part:0,exp:0},Tue:{pay:0,don:0,pend:0,part:0,exp:0},Wed:{pay:0,don:0,pend:0,part:0,exp:0},Thu:{pay:0,don:0,pend:0,part:0,exp:0},Fri:{pay:0,don:0,pend:0,part:0,exp:0},Sat:{pay:0,don:0,pend:0,part:0,exp:0},Sun:{pay:0,don:0,pend:0,part:0,exp:0}};
  var dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  (deposits||[]).forEach(function(d){
    var dt=new Date(d.occurredAt||d.occurred_at||d.createdAt||Date.now());
    var nm=dayNames[dt.getDay()];
    if(map[nm]){
      var k=String(d.kind||d.status||'');
      if(k.indexOf('finalized')!==-1||k==='settled')map[nm].pay++;
      else if(k.indexOf('quarantined')!==-1||k==='failed')map[nm].exp++;
      else map[nm].pend++;
    }
  });
  (payouts||[]).forEach(function(p){
    var dt=new Date(p.createdAt||p.occurred_at||Date.now());
    var nm=dayNames[dt.getDay()];
    if(map[nm]){
      var s=String(p.status||p.kind||'');
      if(s==='settled')map[nm].don++;
      else if(s==='failed')map[nm].exp++;
      else map[nm].pend++;
    }
  });
  var order=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var res=[];
  for(var i=0;i<order.length;i++){
    var o=map[order[i]];
    o.day=order[i];
    res.push(o);
  }
  return res;
}

function renderDailyActivityChart(daysData){
  var defaultDays=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var days=[];
  if(daysData&&daysData.length){
    days=daysData;
  }else{
    for(var k=0;k<7;k++){
      days.push({day:defaultDays[k],pay:0,don:0,pend:0,part:0,exp:0});
    }
  }

  // Find max stacked height to normalize heights up to 140px
  var maxStack=1;
  for(var m=0;m<days.length;m++){
    var total=(days[m].pay||0)+(days[m].don||0)+(days[m].pend||0)+(days[m].part||0)+(days[m].exp||0);
    if(total>maxStack)maxStack=total;
  }

  var bars='';
  for(var i=0;i<days.length;i++){
    var d=days[i];
    var scale=130/maxStack;
    var hPay=Math.round((d.pay||0)*scale);
    var hDon=Math.round((d.don||0)*scale);
    var hPend=Math.round((d.pend||0)*scale);
    var hPart=Math.round((d.part||0)*scale);
    var hExp=Math.round((d.exp||0)*scale);

    bars+='<div class="bar-col">'+
      '<div class="bar-stack">'+
        (hExp>0?'<div class="bar-seg expired" style="height:'+hExp+'px" title="Held / failed: '+(d.exp||0)+'"></div>':'')+
        (hPart>0?'<div class="bar-seg partial" style="height:'+hPart+'px" title="Partial: '+(d.part||0)+'"></div>':'')+
        (hPend>0?'<div class="bar-seg pending" style="height:'+hPend+'px" title="Pending: '+(d.pend||0)+'"></div>':'')+
        (hDon>0?'<div class="bar-seg donations" style="height:'+hDon+'px" title="Payouts: '+(d.don||0)+'"></div>':'')+
        (hPay>0?'<div class="bar-seg payments" style="height:'+hPay+'px" title="Deposits: '+(d.pay||0)+'"></div>':'')+
      '</div>'+
      '<div class="bar-label">'+esc(d.day)+'</div>'+
    '</div>';
  }

  return '<div class="chart-panel">'+
    '<div class="chart-header">'+
      '<h3>Daily activity (7 days)</h3>'+
      // Legend swatches read their colour from the same tokens as the bars, so
      // the two cannot drift and both follow the theme.
      '<div class="chart-legend">'+
        '<div class="legend-item"><span class="legend-dot" style="background:rgb(var(--success))"></span><span>Deposits</span></div>'+
        '<div class="legend-item"><span class="legend-dot" style="background:rgb(var(--warning))"></span><span>Payouts</span></div>'+
        '<div class="legend-item"><span class="legend-dot" style="background:rgb(var(--primary))"></span><span>Pending</span></div>'+
        '<div class="legend-item"><span class="legend-dot" style="background:rgb(var(--accent-lime))"></span><span>Partial</span></div>'+
        '<div class="legend-item"><span class="legend-dot" style="background:rgb(var(--navy-300))"></span><span>Held / failed</span></div>'+
      '</div>'+
    '</div>'+
    '<div class="stacked-bars-container">'+bars+'</div>'+
  '</div>';
}


function group(s){return String(s).replace(/\B(?=(\d{3})+(?!\d))/g,',');}

/**
 * Base units → a human amount. Trailing zeros are trimmed but at least two
 * decimal places are kept, so 1000000 USDT reads "1.00" and 21700 reads "0.0217".
 *
 * An asset the server did not describe returns null decimals: we then say
 * "base units" out loud instead of printing a number that looks like money and
 * is not.
 */
function moneyParts(base,asset){
  var info=assetInfo(asset);
  var s=String(base==null?'0':base);
  var neg=s.charAt(0)==='-';
  if(neg)s=s.slice(1);
  if(!/^[0-9]+$/.test(s))return{text:String(base==null?'':base),raw:true};
  if(!info)return{text:(neg?'-':'')+group(s)+' base units',raw:true};
  var d=info.decimals;
  if(d===0)return{text:(neg?'-':'')+group(s),raw:false};
  while(s.length<=d)s='0'+s;
  var whole=s.slice(0,s.length-d),frac=s.slice(s.length-d);
  frac=frac.replace(/0+$/,'');
  while(frac.length<2)frac+='0';
  return{text:(neg?'-':'')+group(whole)+'.'+frac,raw:false};
}
/** Formatted amount + symbol, e.g. "4.34 USDT". */
function money(base,asset){
  var p=moneyParts(base,asset);
  return p.text+(p.raw&&!assetInfo(asset)?'':' '+String(asset==null?'':asset));
}
/** Same, as HTML with the symbol de-emphasised and sign coloured. */
function moneyHtml(base,asset,signed){
  var p=moneyParts(base,asset);
  var cls=signed?(String(base).charAt(0)==='-'?'neg':'pos'):'';
  return '<span class="amount '+cls+'">'+esc((signed&&String(base).charAt(0)!=='-'?'+':'')+p.text)+
    '<span class="sym">'+esc(String(asset==null?'':asset))+'</span></span>';
}

/**
 * A typed amount ("4.34") → base units ("4340000"), as an exact string.
 *
 * Deliberately string arithmetic: parseFloat('0.07')*1e6 is 69999.99999999999, and
 * a payout is not somewhere to discover that. Returns null when the input is not a
 * number, the asset is unknown, or more decimal places were given than the asset
 * has — an amount we cannot represent exactly is refused rather than rounded.
 */
function toBaseUnits(input,asset){
  var info=assetInfo(asset);
  if(!info)return null;
  var s=String(input==null?'':input).trim().replace(/,/g,'');
  if(s===''||s==='.'||!/^[0-9]*(\.[0-9]*)?$/.test(s))return null;
  var parts=s.split('.'),whole=parts[0]||'0',frac=parts[1]||'';
  if(frac.length>info.decimals)return null;
  while(frac.length<info.decimals)frac+='0';
  var out=(whole+frac).replace(/^0+/,'');
  return out===''?'0':out;
}

var ACCOUNT_NAMES={
  merchant_available:'Merchant balance',
  merchant_pending:'Merchant pending',
  compliance_suspense:'Compliance hold',
  pool_addr:'Deposit wallet',
  pool_addr_unconfirmed:'Deposit wallet (unconfirmed)',
  treasury:'Treasury',
  cold:'Cold storage',
  gas_float:'Gas float'
};
function titleize(s){s=String(s||'').replace(/_/g,' ');return s.charAt(0).toUpperCase()+s.slice(1);}

/** 'merchant_available:<tenant>:<account>' → "Merchant balance". */
function accountName(key){
  var parts=String(key||'').split(':');
  var p=parts[0]||'';
  var name=ACCOUNT_NAMES[p];
  if(!name){
    // The prefix often already names the fee ('egofi_fee_revenue'), so append only
    // the suffix rather than re-stating it.
    if(/_revenue$/.test(p))name=titleize(p.replace(/_revenue$/,''))+' revenue';
    else if(/_expense$/.test(p))name=titleize(p.replace(/_expense$/,''))+' expense';
    else name=titleize(p);
  }
  // pool_addr keys carry the chain in slot 1; it is the useful half of the tail.
  if(p.indexOf('pool_addr')===0&&parts[1])name+=' · '+parts[1];
  return name;
}
/** Shorten a long identifier from the middle, keeping both recognisable ends. */
function midTrunc(s,keep){
  s=String(s==null?'':s);keep=keep||10;
  return s.length<=keep*2+1?s:s.slice(0,keep)+'…'+s.slice(-keep);
}
/**
 * Two-line account cell: the plain name, with the raw ledger key beneath it for
 * anyone who needs to trace it. The key is truncated and the full value put on
 * the title — at full length it is longer than everything else in the row put
 * together, and it buries the name it is supposed to annotate.
 */
function accountCell(key){
  var parts=String(key||'').split(':');
  // Keep the prefix and chain readable; only the uuid tail gets shortened.
  var shown=parts.map(function(p,i){return i===0?p:midTrunc(p,6);}).join(':');
  return '<span class="acct" title="'+esc(key)+'"><span class="name">'+esc(accountName(key))+
    '</span><span class="sub">'+esc(shown)+'</span></span>';
}

/** Inline nav icons — self-contained, since the console ships without a CDN. */
var ICONS={
  overview:'M3 12h4l2.5-7 4 14L16 12h5',
  tenants:'M4 20V9l8-5 8 5v11M4 20h16M9.5 20v-5h5v5',
  ledger:'M4 5.5A1.5 1.5 0 015.5 4H19v16H5.5A1.5 1.5 0 014 18.5zM8 8h7M8 12h7',
  deposits:'M12 4v12m0 0l-5-5m5 5l5-5M4 20h16',
  payouts:'M12 20V8m0 0L7 13m5-5l5 5M4 4h16',
  accounts:'M16 20v-2a4 4 0 00-8 0v2M12 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7',
  allowlist:'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4',
  webhooks:'M9 17H7A4 4 0 017 9h1m6 8h2a4 4 0 000-8h-1M9 13h6',
  audit:'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  earnings:'M12 2v20m5-17H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  errors:'M12 8v5m0 3.5h.01M10.3 4.3L2.8 17a2 2 0 001.7 3h15a2 2 0 001.7-3L14.7 4.3a2 2 0 00-3.4 0z',
  accounting:'M9 7h6m-6 4h6m-6 4h4M3 3h18v18H3z',
  ai:'M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a6 6 0 110 12 6 6 0 010-12z',
  por_pos:'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 10h6v-6h-6z'
};
function navIcon(name){
  var d=ICONS[name];
  if(!d)return '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '+
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+d+'"/></svg>';
}

var KIND_LABELS={
  'deposit.detected':'Deposit seen on-chain',
  'deposit.confirmed':'Deposit confirming',
  'deposit.finalized':'Deposit received',
  'deposit.quarantined':'Deposit held for review',
  'deposit.released':'Deposit released from hold',
  'deposit.reorged':'Deposit reversed (chain reorg)',
  'payout.locked':'Payout funds locked',
  'payout.settled':'Payout sent',
  'fee.swept':'Fees swept',
  reverse:'Correcting reversal'
};
function kindLabel(k){
  k=String(k==null?'':k);
  if(KIND_LABELS[k])return KIND_LABELS[k];
  if(k.indexOf('reverse')===0)return 'Correcting reversal';
  return titleize(k.replace(/\./g,' '));
}
function kindClass(k){
  k=String(k==null?'':k);
  if(k.indexOf('reverse')===0||k==='deposit.reorged')return 'warn';
  if(k==='deposit.quarantined')return 'bad';
  if(k==='deposit.finalized'||k==='payout.settled')return 'ok';
  return 'muted';
}
var STATUS_LABELS={
  pending:'Pending',broadcasting:'Sending',broadcast:'Sent',settled:'Confirmed',failed:'Failed',
  delivered:'Delivered',dead:'Given up',
  AVAILABLE:'Ready to use',IN_USE:'In use',COOLING:'Cooling down'
};
function statusLabel(s){var k=String(s==null?'':s);return STATUS_LABELS[k]||titleize(k);}

/** Relative time, with the exact timestamp available on hover. */
function ago(iso){
  if(!iso)return '';
  var t=new Date(iso).getTime();
  if(isNaN(t))return String(iso);
  var secs=Math.round((Date.now()-t)/1000);
  var abs=Math.abs(secs),unit,n;
  if(abs<60){return secs>=0?'just now':'in a moment';}
  if(abs<3600){n=Math.round(abs/60);unit='minute';}
  else if(abs<86400){n=Math.round(abs/3600);unit='hour';}
  else if(abs<2592000){n=Math.round(abs/86400);unit='day';}
  else{n=Math.round(abs/2592000);unit='month';}
  var phrase=n+' '+unit+(n===1?'':'s');
  return secs>=0?phrase+' ago':'in '+phrase;
}
/** Milliseconds as a duration a person reads, e.g. 86400000 → "24 hours". */
function humanMs(ms){
  var n=Number(ms);
  if(!isFinite(n))return String(ms);
  var units=[[86400000,'day'],[3600000,'hour'],[60000,'minute'],[1000,'second']];
  for(var i=0;i<units.length;i++){
    if(n>=units[i][0]){
      var v=n/units[i][0];
      v=Math.round(v*100)/100;
      return v+' '+units[i][1]+(v===1?'':'s');
    }
  }
  return n+' ms';
}
function whenCell(iso){
  if(!iso)return '';
  var exact=new Date(iso);
  var title=isNaN(exact)?String(iso):exact.toISOString().replace('T',' ').slice(0,19)+' UTC';
  return '<span title="'+esc(title)+'">'+esc(ago(iso))+'</span>';
}

// ── Clipboard, downloads, modal ─────────────────────────────────────────────
function showToast(msg){
  var c=document.getElementById('toast-box');
  if(!c){c=document.createElement('div');c.id='toast-box';c.className='toast-container';document.body.appendChild(c);}
  var t=document.createElement('div');t.className='toast';
  t.innerHTML='<span style="color:rgb(var(--success));font-size:16px;">✓</span> <span>'+esc(msg)+'</span>';
  c.appendChild(t);
  setTimeout(function(){
    t.style.opacity='0';t.style.transform='translateY(10px)';t.style.transition='all 0.22s ease';
    setTimeout(function(){t.remove();},220);
  },2400);
}

function copyText(text,btn){
  var done=function(){
    showToast('Copied to clipboard');
    if(!btn)return;
    var old=btn.getAttribute('data-label')||btn.textContent;
    btn.setAttribute('data-label',old);
    btn.textContent='✓ Copied';
    setTimeout(function(){btn.textContent=old;},1400);
  };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done,function(){fallbackCopy(text);done();});
  }else{fallbackCopy(text);done();}
}
function fallbackCopy(text){
  var ta=document.createElement('textarea');
  ta.value=text;ta.setAttribute('readonly','');
  ta.style.position='fixed';ta.style.opacity='0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');}catch(e){}
  document.body.removeChild(ta);
}
function downloadBlob(blob,filename){
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url);},2000);
}
function downloadText(text,filename){
  downloadBlob(new Blob([text],{type:'text/plain;charset=utf-8'}),filename);
}
/** True when the browser can offer a native share sheet for plain text. */
function canShare(){return typeof navigator!=='undefined'&&!!navigator.share;}
function shareText(title,text){
  if(!canShare())return Promise.resolve(false);
  return navigator.share({title:title,text:text}).then(function(){return true;},function(){return false;});
}

var modalEl=null;
function closeModal(){if(modalEl&&modalEl.parentNode)modalEl.parentNode.removeChild(modalEl);modalEl=null;}
/**
 * Open a modal. 'footHtml' is raw HTML for the button row; 'onMount' receives the
 * modal element so callers can wire their own buttons.
 */
function openModal(title,bodyHtml,footHtml,onMount){
  closeModal();
  modalEl=document.createElement('div');
  modalEl.className='modal-back';
  modalEl.innerHTML='<div class="modal" role="dialog" aria-modal="true"><header><h3>'+esc(title)+
    '</h3><button class="x" data-close aria-label="Close">&times;</button></header><div class="body">'+
    bodyHtml+'</div><div class="foot">'+(footHtml||'')+'</div></div>';
  document.body.appendChild(modalEl);
  modalEl.addEventListener('click',function(e){if(e.target===modalEl)closeModal();});
  modalEl.querySelectorAll('[data-close]').forEach(function(b){b.onclick=closeModal;});
  document.addEventListener('keydown',function onEsc(e){
    if(e.key==='Escape'){closeModal();document.removeEventListener('keydown',onEsc);}
  });
  if(onMount)onMount(modalEl);
  return modalEl;
}

// ── QR encoder (byte mode, ECC level M, versions 1–10) ──────────────────────
// Dependency-free on purpose: the console ships with no build step and no CDN,
// and a deposit address should never be handed to a third-party QR service.
var QR=(function(){
  var EXP=new Uint8Array(512),LOG=new Uint8Array(256);
  (function(){var x=1;for(var i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&0x100)x^=0x11d;}
   for(var j=255;j<512;j++)EXP[j]=EXP[j-255];})();
  function mul(a,b){return a===0||b===0?0:EXP[LOG[a]+LOG[b]];}
  function rsGen(n){
    var p=[1];
    for(var i=0;i<n;i++){
      var q=p.slice();q.push(0);
      for(var j=0;j<p.length;j++)q[j+1]^=mul(p[j],EXP[i]);
      p=q;
    }
    return p;
  }
  function rsEnc(data,n){
    var gen=rsGen(n),res=[],i,j;
    for(i=0;i<n;i++)res.push(0);
    for(i=0;i<data.length;i++){
      var f=data[i]^res[0];
      res.shift();res.push(0);
      if(f!==0)for(j=0;j<n;j++)res[j]^=mul(gen[j+1],f);
    }
    return res;
  }
  // Per version (1-indexed): [ecCodewordsPerBlock, [[blockCount, dataCodewords], …]]
  var BLOCKS=[
    [10,[[1,16]]],[16,[[1,28]]],[26,[[1,44]]],[18,[[2,32]]],[24,[[2,43]]],
    [16,[[4,27]]],[18,[[4,31]]],[22,[[2,38],[2,39]]],[22,[[3,36],[2,37]]],[26,[[4,43],[1,44]]]
  ];
  var ALIGN=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
  function dataCodewords(v){
    var g=BLOCKS[v-1][1],n=0;
    for(var i=0;i<g.length;i++)n+=g[i][0]*g[i][1];
    return n;
  }
  /** Byte capacity: data bits minus the 4-bit mode and the length field. */
  function capacity(v){return Math.floor((dataCodewords(v)*8-(4+(v>=10?16:8)))/8);}

  function utf8(str){
    var out=[],i,c;
    for(i=0;i<str.length;i++){
      c=str.charCodeAt(i);
      if(c<0x80)out.push(c);
      else if(c<0x800){out.push(0xc0|(c>>6),0x80|(c&63));}
      else if(c>=0xd800&&c<0xdc00&&i+1<str.length){
        var c2=str.charCodeAt(++i),cp=0x10000+((c-0xd800)<<10)+(c2-0xdc00);
        out.push(0xf0|(cp>>18),0x80|((cp>>12)&63),0x80|((cp>>6)&63),0x80|(cp&63));
      }
      else out.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63));
    }
    return out;
  }
  // BCH(15,5) format info, level M ('00'), XORed with the spec's mask.
  function formatBits(mask){
    var v=(0<<3)|mask,d=v<<10;
    for(var i=4;i>=0;i--)if(d&(1<<(i+10)))d^=0x537<<i;
    return ((v<<10)|d)^0x5412;
  }
  function versionBits(v){
    var d=v<<12;
    for(var i=5;i>=0;i--)if(d&(1<<(i+12)))d^=0x1f25<<i;
    return (v<<12)|d;
  }

  function encode(text){
    var bytes=utf8(text),v=-1,i,j;
    for(i=1;i<=10;i++)if(bytes.length<=capacity(i)){v=i;break;}
    if(v<0)throw new Error('Too much data for a version-10 QR code');

    // Bit stream: mode, length, payload, terminator, byte-align, pad bytes.
    var bits=[];
    function push(val,len){for(var b=len-1;b>=0;b--)bits.push((val>>b)&1);}
    push(4,4);
    push(bytes.length,v>=10?16:8);
    for(i=0;i<bytes.length;i++)push(bytes[i],8);
    var total=dataCodewords(v)*8;
    for(i=0;i<4&&bits.length<total;i++)bits.push(0);
    while(bits.length%8!==0)bits.push(0);
    var pads=[0xec,0x11],p=0;
    while(bits.length<total){push(pads[p++%2],8);}
    var cw=[];
    for(i=0;i<bits.length;i+=8){
      var b=0;for(j=0;j<8;j++)b=(b<<1)|bits[i+j];
      cw.push(b);
    }

    // Split into blocks, RS-encode each, then interleave (data, then EC).
    var ecLen=BLOCKS[v-1][0],groups=BLOCKS[v-1][1];
    var dblocks=[],eblocks=[],off=0;
    for(i=0;i<groups.length;i++){
      for(j=0;j<groups[i][0];j++){
        var d=cw.slice(off,off+groups[i][1]);off+=groups[i][1];
        dblocks.push(d);eblocks.push(rsEnc(d,ecLen));
      }
    }
    var out=[],maxD=0;
    for(i=0;i<dblocks.length;i++)if(dblocks[i].length>maxD)maxD=dblocks[i].length;
    for(i=0;i<maxD;i++)for(j=0;j<dblocks.length;j++)if(i<dblocks[j].length)out.push(dblocks[j][i]);
    for(i=0;i<ecLen;i++)for(j=0;j<eblocks.length;j++)out.push(eblocks[j][i]);

    // Lay out the matrix: function patterns first, so data placement can skip them.
    var size=17+4*v;
    var m=[],res=[];
    for(i=0;i<size;i++){m.push(new Array(size).fill(0));res.push(new Array(size).fill(0));}
    function set(r,c,val){m[r][c]=val?1:0;res[r][c]=1;}
    function finder(r,c){
      for(var dr=-1;dr<=7;dr++)for(var dc=-1;dc<=7;dc++){
        var rr=r+dr,cc=c+dc;
        if(rr<0||cc<0||rr>=size||cc>=size)continue;
        var on=(dr>=0&&dr<=6&&(dc===0||dc===6))||(dc>=0&&dc<=6&&(dr===0||dr===6))||
               (dr>=2&&dr<=4&&dc>=2&&dc<=4);
        set(rr,cc,on);
      }
    }
    finder(0,0);finder(0,size-7);finder(size-7,0);
    for(i=8;i<size-8;i++){set(6,i,i%2===0);set(i,6,i%2===0);}
    var ap=ALIGN[v-1];
    for(i=0;i<ap.length;i++)for(j=0;j<ap.length;j++){
      var ar=ap[i],ac=ap[j];
      if((ar<=8&&ac<=8)||(ar<=8&&ac>=size-9)||(ar>=size-9&&ac<=8))continue;
      for(var y=-2;y<=2;y++)for(var x=-2;x<=2;x++)
        set(ar+y,ac+x,Math.max(Math.abs(y),Math.abs(x))!==1);
    }
    set(size-8,8,1); // the always-dark module
    // Reserve the format areas so data skips them; real bits are written after masking.
    for(i=0;i<9;i++){if(i!==6){res[8][i]=1;res[i][8]=1;}}
    for(i=0;i<8;i++){res[8][size-1-i]=1;res[size-1-i][8]=1;}
    res[8][8]=1;
    if(v>=7)for(i=0;i<6;i++)for(j=0;j<3;j++){res[i][size-11+j]=1;res[size-11+j][i]=1;}

    // Zigzag data placement, bottom-right upward, skipping the vertical timing column.
    var bi=0,dir=-1,row=size-1;
    for(var col=size-1;col>0;col-=2){
      if(col===6)col--;
      for(;;){
        for(var k=0;k<2;k++){
          var cc2=col-k;
          if(!res[row][cc2]){
            var bit=0;
            if(bi<out.length*8)bit=(out[bi>>3]>>(7-(bi&7)))&1;
            bi++;
            m[row][cc2]=bit;
          }
        }
        row+=dir;
        if(row<0||row>=size){row-=dir;dir=-dir;break;}
      }
    }

    function maskFn(k,r,c){
      switch(k){
        case 0:return (r+c)%2===0;
        case 1:return r%2===0;
        case 2:return c%3===0;
        case 3:return (r+c)%3===0;
        case 4:return (Math.floor(r/2)+Math.floor(c/3))%2===0;
        case 5:return ((r*c)%2)+((r*c)%3)===0;
        case 6:return (((r*c)%2)+((r*c)%3))%2===0;
        default:return (((r+c)%2)+((r*c)%3))%2===0;
      }
    }
    function penalty(g){
      var n=g.length,sc=0,r,c,run,i2,dark=0;
      for(r=0;r<n;r++){run=1;for(c=1;c<n;c++){
        if(g[r][c]===g[r][c-1])run++;else{if(run>=5)sc+=3+(run-5);run=1;}}
        if(run>=5)sc+=3+(run-5);}
      for(c=0;c<n;c++){run=1;for(r=1;r<n;r++){
        if(g[r][c]===g[r-1][c])run++;else{if(run>=5)sc+=3+(run-5);run=1;}}
        if(run>=5)sc+=3+(run-5);}
      for(r=0;r<n-1;r++)for(c=0;c<n-1;c++)
        if(g[r][c]===g[r][c+1]&&g[r][c]===g[r+1][c]&&g[r][c]===g[r+1][c+1])sc+=3;
      var pat=[1,0,1,1,1,0,1,0,0,0,0];
      function match(get){
        var hits=0;
        for(var s=0;s+11<=n;s++){
          var ok=true;
          for(i2=0;i2<11;i2++)if(get(s+i2)!==pat[i2]){ok=false;break;}
          if(ok)hits++;
          var ok2=true;
          for(i2=0;i2<11;i2++)if(get(s+i2)!==pat[10-i2]){ok2=false;break;}
          if(ok2)hits++;
        }
        return hits;
      }
      for(r=0;r<n;r++)sc+=40*match((function(rr){return function(i3){return g[rr][i3];};})(r));
      for(c=0;c<n;c++)sc+=40*match((function(cc3){return function(i3){return g[i3][cc3];};})(c));
      for(r=0;r<n;r++)for(c=0;c<n;c++)if(g[r][c])dark++;
      sc+=10*Math.floor(Math.abs(dark*100/(n*n)-50)/5);
      return sc;
    }

    var best=null,bestScore=Infinity,bestMask=0;
    for(var mk=0;mk<8;mk++){
      var g2=[];
      for(i=0;i<size;i++){
        g2.push(m[i].slice());
        for(j=0;j<size;j++)if(!res[i][j]&&maskFn(mk,i,j))g2[i][j]^=1;
      }
      // Format bits belong to the candidate being scored, not to the unmasked grid.
      var fb=formatBits(mk);
      for(i=0;i<15;i++){
        var bit2=(fb>>i)&1;
        // Copy 1 runs down column 8 then along row 8; copy 2 mirrors it. Both skip
        // the timing modules at (6,8) and (8,6).
        if(i<6)g2[i][8]=bit2;
        else if(i<8)g2[i+1][8]=bit2;
        else g2[size-15+i][8]=bit2;
        if(i<8)g2[8][size-1-i]=bit2;
        else if(i===8)g2[8][7]=bit2;
        else g2[8][14-i]=bit2;
      }
      g2[size-8][8]=1;
      if(v>=7){
        var vb=versionBits(v);
        for(i=0;i<18;i++){
          var b3=(vb>>i)&1,rr2=Math.floor(i/3),cc4=i%3;
          g2[rr2][size-11+cc4]=b3;g2[size-11+cc4][rr2]=b3;
        }
      }
      var sc2=penalty(g2);
      if(sc2<bestScore){bestScore=sc2;best=g2;bestMask=mk;}
    }
    return best;
  }

  /** Draw a matrix into a canvas at 'scale' device pixels per module. */
  function draw(canvas,matrix,scale,quiet){
    scale=scale||6;quiet=quiet==null?4:quiet;
    var n=matrix.length,px=(n+quiet*2)*scale;
    canvas.width=px;canvas.height=px;
    var ctx=canvas.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,px,px);
    ctx.fillStyle='#000';
    for(var r=0;r<n;r++)for(var c=0;c<n;c++)
      if(matrix[r][c])ctx.fillRect((c+quiet)*scale,(r+quiet)*scale,scale,scale);
  }
  function toSvg(matrix,quiet){
    quiet=quiet==null?4:quiet;
    var n=matrix.length,dim=n+quiet*2,d='';
    for(var r=0;r<n;r++)for(var c=0;c<n;c++)
      if(matrix[r][c])d+='M'+(c+quiet)+' '+(r+quiet)+'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+dim+' '+dim+'" '+
      'shape-rendering="crispEdges"><rect width="'+dim+'" height="'+dim+'" fill="#fff"/>'+
      '<path d="'+d+'" fill="#000"/></svg>';
  }
  return {encode:encode,draw:draw,toSvg:toSvg};
})();

/**
 * A wallet-openable payment URI. Only emitted for chains with a URI scheme we are
 * confident about — a wrong scheme silently sends a payer nowhere, which is worse
 * than offering only the address.
 */
var PAY_URI_SCHEMES={TRON:'tron',POLYGON:'ethereum',BSC:'ethereum',ARBITRUM:'ethereum',BASE:'ethereum'};
function paymentUri(chain,address,asset,amount){
  var scheme=PAY_URI_SCHEMES[String(chain||'').toUpperCase()];
  if(!scheme)return null;
  var uri=scheme+':'+address;
  if(amount)uri+='?amount='+encodeURIComponent(amount);
  return uri;
}
`;
