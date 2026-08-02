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
 * The whole visual system for both consoles. Each SPA supplies only its accent
 * hue (admin blue, portal teal) — everything structural is shared, so the two
 * cannot drift apart the way two hand-maintained copies of the same 50 lines do.
 */
export const UI_KIT_CSS = `
:root{
  --bg:#0b0e13; --panel:#12171f; --panel2:#1a212c; --raised:#212a37;
  --line:#232c39; --line2:#2e3947;
  --fg:#e8eef6; --fg2:#b7c3d2; --muted:#7d8b9e; --faint:#5a6675;
  --ok:#3fb950; --ok-bg:rgba(63,185,80,.12);
  --warn:#d6a12a; --warn-bg:rgba(214,161,42,.12);
  --bad:#f0524a; --bad-bg:rgba(240,82,74,.12);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  --r:10px; --r-sm:7px;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px -12px rgba(0,0,0,.6);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{letter-spacing:-.011em}
::selection{background:color-mix(in srgb,var(--accent) 35%,transparent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

/* ── Controls ────────────────────────────────────────────────────────────── */
button{font:500 13px/1.2 var(--sans);cursor:pointer;border:1px solid var(--line2);
  background:var(--raised);color:var(--fg);border-radius:var(--r-sm);padding:8px 13px;
  transition:background .13s,border-color .13s,color .13s;white-space:nowrap}
button:hover{background:#283242;border-color:#3a4655}
button:active{transform:translateY(.5px)}
button:disabled{opacity:.5;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:#08131f;font-weight:600}
button.primary:hover{background:var(--accent-hi);border-color:var(--accent-hi)}
button.danger{background:transparent;border-color:color-mix(in srgb,var(--bad) 45%,transparent);color:var(--bad)}
button.danger:hover{background:var(--bad-bg);border-color:var(--bad)}
input,select{font:14px var(--sans);background:var(--bg);border:1px solid var(--line2);
  color:var(--fg);border-radius:var(--r-sm);padding:9px 11px;transition:border-color .13s}
input:hover,select:hover{border-color:#3a4655}
input:focus,select:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
input::placeholder{color:var(--faint)}

/* ── Sign-in ─────────────────────────────────────────────────────────────── */
.login{max-width:390px;margin:12vh auto;padding:32px;background:var(--panel);
  border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
.login .mark{width:34px;height:34px;border-radius:9px;margin-bottom:16px;
  background:linear-gradient(135deg,var(--accent),var(--accent-hi));
  display:flex;align-items:center;justify-content:center;color:#08131f;font-weight:800;font-size:16px}
.login h1{font-size:19px;margin:0 0 5px;font-weight:650}
.login p{color:var(--muted);margin:0 0 20px;font-size:13px;line-height:1.5}
.login input{width:100%;margin-bottom:12px}
.login button{width:100%;padding:10px}
.err{color:var(--bad);font-size:13px;min-height:18px;margin-top:10px}

/* ── Shell ───────────────────────────────────────────────────────────────── */
.shell{display:grid;grid-template-columns:224px 1fr;min-height:100vh}
.side{background:var(--panel);border-right:1px solid var(--line);padding:16px 12px;
  display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;padding:6px 10px 20px}
.brand .mark{width:28px;height:28px;border-radius:8px;flex:none;
  background:linear-gradient(135deg,var(--accent),var(--accent-hi));
  display:flex;align-items:center;justify-content:center;color:#08131f;font-weight:800;font-size:14px}
.brand b{display:block;font-size:14.5px;font-weight:650;letter-spacing:-.01em;line-height:1.25}
.brand small{display:block;color:var(--muted);font-weight:400;font-size:11px;line-height:1.3}
.nav{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--r-sm);
  color:var(--fg2);cursor:pointer;font-size:13.5px;font-weight:500;
  transition:background .13s,color .13s;user-select:none}
.nav svg{width:16px;height:16px;flex:none;opacity:.75}
.nav:hover{background:var(--panel2);color:var(--fg)}
.nav.active{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--fg)}
.nav.active svg{opacity:1;color:var(--accent)}
.side .spacer{flex:1}
.side>button{margin-top:6px;width:100%}
.main{padding:26px 30px 60px;overflow:auto;min-width:0}
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
.head h2{margin:0;font-size:21px;font-weight:650}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}

/* ── Cards ───────────────────────────────────────────────────────────────── */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:15px 16px;
  transition:border-color .13s}
.card:hover{border-color:var(--line2)}
.card .k{color:var(--muted);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.card .v{font-size:25px;font-weight:650;margin-top:5px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}

/* ── Panels + tables ─────────────────────────────────────────────────────── */
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);
  overflow:hidden;margin-bottom:22px}
.panel h3{margin:0;padding:13px 18px;font-size:12px;color:var(--muted);font-weight:650;
  border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.6px}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:11px 18px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:650;font-size:11px;text-transform:uppercase;letter-spacing:.6px;
  background:var(--panel);position:sticky;top:0;z-index:1;white-space:nowrap}
tbody tr{transition:background .1s}
tbody tr:hover{background:var(--panel2)}
tbody tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.mono,.mono{font-family:var(--mono);font-size:12px}
.muted{color:var(--muted)}
.actions{white-space:nowrap}
.actions button{padding:5px 10px;font-size:12px;margin-left:6px}
.actions button:first-child{margin-left:0}
.empty{padding:34px 26px;text-align:center;color:var(--muted);font-size:13.5px}
.hint{color:var(--muted);font-size:12.5px;padding:12px 18px;margin:0;border-top:1px solid var(--line);line-height:1.55}
.panel>.hint:first-child{border-top:none}

/* ── Badges ──────────────────────────────────────────────────────────────── */
.badge{display:inline-block;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;
  border:1px solid transparent;white-space:nowrap;line-height:1.35}
.badge.ok{color:#69d97c;background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 30%,transparent)}
.badge.warn{color:#e8bc55;background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.badge.bad{color:#ff7d76;background:var(--bad-bg);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
.badge.muted{color:var(--fg2);background:var(--panel2);border-color:var(--line2)}

/* ── Banners ─────────────────────────────────────────────────────────────── */
.banner{padding:12px 16px;border-radius:var(--r-sm);margin-bottom:18px;font-weight:500;font-size:13.5px;
  border:1px solid;line-height:1.5}
.banner.bad{background:var(--bad-bg);border-color:color-mix(in srgb,var(--bad) 40%,transparent);color:#ff9d97}
.banner.ok{background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 35%,transparent);color:#8ae79b}
.banner.warn{background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 40%,transparent);color:#eccb74}

/* ── Money + account cells ───────────────────────────────────────────────── */
.amount{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:550}
.amount .sym{color:var(--muted);font-size:.82em;margin-left:4px;font-weight:400}
.pos{color:var(--fg)} .neg{color:var(--fg)}
/* The name and the raw key are separate LINES. Both are spans, so they need an
   explicit block — inline is what made them collide into one run of text. */
.acct{display:block;min-width:0}
.acct .name{display:block;font-weight:550;line-height:1.35}
.acct .sub{display:block;color:var(--faint);font-family:var(--mono);font-size:10.5px;
  line-height:1.4;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34ch}
.movement{display:flex;align-items:baseline;gap:10px;padding:3px 0}
.movement .dir{color:var(--muted);font-size:11px;min-width:32px;text-transform:uppercase;
  letter-spacing:.4px;font-weight:600}
.movement .amt{min-width:118px;text-align:right}

/* ── Forms ───────────────────────────────────────────────────────────────── */
.form{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;padding:16px 18px}
.form label{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--muted);
  font-weight:600;text-transform:uppercase;letter-spacing:.4px}

/* ── Modal ───────────────────────────────────────────────────────────────── */
.modal-back{position:fixed;inset:0;background:rgba(4,7,11,.72);backdrop-filter:blur(3px);
  display:flex;align-items:center;justify-content:center;padding:20px;z-index:50;
  animation:fade .14s ease-out}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(6px) scale(.995)}to{opacity:1;transform:none}}
.modal{background:var(--panel);border:1px solid var(--line2);border-radius:13px;max-width:580px;
  width:100%;max-height:90vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,.6);
  animation:rise .16s ease-out}
.modal header{padding:17px 20px;border-bottom:1px solid var(--line);display:flex;
  align-items:center;justify-content:space-between;gap:12px}
.modal header h3{margin:0;font-size:16px;font-weight:650}
.modal .body{padding:20px}
.modal .foot{padding:15px 20px;border-top:1px solid var(--line);display:flex;gap:10px;
  justify-content:flex-end;flex-wrap:wrap;background:var(--panel2)}
.modal .x{background:none;border:none;color:var(--muted);font-size:22px;line-height:1;padding:2px 6px}
.modal .x:hover{background:var(--panel2);color:var(--fg)}
.modal .hint{border-top:none;padding:10px 0 0}
.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;align-items:baseline;margin:0 0 18px}
.kv dt{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.kv dd{margin:0;font-family:var(--mono);font-size:12.5px;word-break:break-all}
.secretbox{background:var(--bg);border:1px dashed color-mix(in srgb,var(--warn) 55%,transparent);
  border-radius:var(--r-sm);padding:13px 14px;font-family:var(--mono);font-size:12.5px;
  word-break:break-all;margin:8px 0 4px;line-height:1.6;color:#f0d79a}
.warnnote{color:var(--warn);font-size:12px;margin:0 0 6px;font-weight:650;
  text-transform:uppercase;letter-spacing:.5px}

/* ── Deposit-address sheet ───────────────────────────────────────────────── */
.qrwrap{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
.qrbox{background:#fff;padding:12px;border-radius:11px;line-height:0;flex:none;
  box-shadow:0 2px 12px rgba(0,0,0,.35)}
.qrbox canvas{display:block;width:184px;height:184px;image-rendering:pixelated}
.qrside{flex:1;min-width:230px}
.addr{font-family:var(--mono);font-size:12.5px;word-break:break-all;background:var(--bg);
  border:1px solid var(--line2);border-radius:var(--r-sm);padding:11px 13px;margin-bottom:12px;
  line-height:1.6;user-select:all}
.btnrow{display:flex;gap:8px;flex-wrap:wrap}
.btnrow button{padding:7px 11px;font-size:12.5px}

@media (max-width:820px){
  .shell{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;
    border-right:none;border-bottom:1px solid var(--line);padding:10px 12px}
  .brand{padding:0 12px 0 4px}
  .side .spacer{flex:0}
  .side>button{width:auto;margin-top:0}
  .main{padding:20px 16px 50px}
  th,td{padding:10px 12px}
}
@media print{
  body{background:#fff;color:#000}
  .side,.head button,.btnrow,.modal .foot,.nav{display:none !important}
  .modal-back{position:static;background:none;padding:0;backdrop-filter:none}
  .modal{border:none;box-shadow:none;max-width:none;max-height:none;animation:none}
  .qrbox{border:1px solid #ccc;box-shadow:none}
  .addr{background:none;border:1px solid #ccc;color:#000}
}
`;

export const UI_KIT_JS = String.raw`
// ── Money, labels, and other display helpers ────────────────────────────────
var ASSETS={};
/** Cache the API's asset table (symbol → decimals). Call before formatting money. */
function setAssets(list){ASSETS={};for(var i=0;i<(list||[]).length;i++){var a=list[i];ASSETS[String(a.symbol).toUpperCase()]=a;}}
function assetInfo(sym){return ASSETS[String(sym==null?'':sym).toUpperCase()]||null;}

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
  errors:'M12 8v5m0 3.5h.01M10.3 4.3L2.8 17a2 2 0 001.7 3h15a2 2 0 001.7-3L14.7 4.3a2 2 0 00-3.4 0z'
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
function copyText(text,btn){
  var done=function(){
    if(!btn)return;
    var old=btn.getAttribute('data-label')||btn.textContent;
    btn.setAttribute('data-label',old);
    btn.textContent='Copied';
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
