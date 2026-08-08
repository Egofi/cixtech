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
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&display=swap');

:root{
  --bg:#0b0e17; --panel:#151828; --panel2:#1a1e30; --raised:#1e2338;
  --line:rgba(255,255,255,0.09); --line2:rgba(255,255,255,0.18);
  --fg:#f8fafc; --fg2:#cbd5e1; --muted:#8ca0ba; --faint:#64748b;
  --cyan:#00e5ff; --purple:#b854fd; --green:#00e676; --orange:#ff9100;
  --ok:#00e676; --ok-bg:rgba(0,230,118,0.15);
  --warn:#ff9100; --warn-bg:rgba(255,145,0,0.15);
  --bad:#ef4444; --bad-bg:rgba(239,68,68,0.15);
  --accent-glow:rgba(0,229,255,0.35);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --display:'Outfit','Inter',sans-serif;
  --r:14px; --r-sm:9px;
  --shadow:0 14px 45px rgba(0,0,0,0.65),0 3px 12px rgba(0,0,0,0.4);
  --glass-bg:rgba(21,24,40,0.85);
  --glass-border:1px solid rgba(255,255,255,0.1);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:radial-gradient(circle at 50% 0%,#171b2d 0%,#0b0e17 80%);color:var(--fg);
  font:14px/1.6 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent);text-decoration:none;transition:color .15s}
a:hover{color:var(--accent-hi);text-decoration:none}
h1,h2,h3,h4{font-family:var(--display);letter-spacing:-.02em}
::selection{background:color-mix(in srgb,var(--accent) 40%,transparent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

@keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
@keyframes pulseDot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.3;transform:scale(0.85)} }
@keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }

/* ── Controls ────────────────────────────────────────────────────────────── */
button{font:600 13px/1.2 var(--sans);cursor:pointer;border:var(--glass-border);
  background:var(--raised);color:var(--fg);border-radius:var(--r-sm);padding:9.5px 16px;
  transition:all .2s cubic-bezier(0.16, 1, 0.3, 1);white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.2)}
button:hover{background:#282f4a;border-color:rgba(255,255,255,0.28);transform:translateY(-1.5px);box-shadow:0 6px 18px rgba(0,0,0,0.35)}
button:active{transform:translateY(0)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none}
button.primary{background:linear-gradient(135deg,var(--accent),var(--accent-hi));border:none;color:#041119;font-weight:700;box-shadow:0 4px 18px var(--accent-glow)}
button.primary:hover{box-shadow:0 6px 24px color-mix(in srgb,var(--accent) 55%,transparent);transform:translateY(-1.5px)}
button.danger{background:transparent;border-color:color-mix(in srgb,var(--bad) 45%,transparent);color:var(--bad)}
button.danger:hover{background:var(--bad-bg);border-color:var(--bad)}
input,select,textarea{font:14px var(--sans);background:rgba(11,14,23,0.85);border:var(--glass-border);
  color:var(--fg);border-radius:var(--r-sm);padding:10.5px 14px;transition:all .18s ease;backdrop-filter:blur(8px)}
input:hover,select:hover,textarea:hover{border-color:rgba(255,255,255,0.25)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
input::placeholder,textarea::placeholder{color:var(--faint)}

/* ── Top Navigation Bar ─────────────────────────────────────────────────── */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 28px;
  background:rgba(17,20,34,0.75);backdrop-filter:blur(18px);border-bottom:1px solid var(--line);
  position:sticky;top:0;z-index:40;margin-bottom:24px}
.topbar-left{display:flex;align-items:center;gap:16px}
.status-pill{display:flex;align-items:center;gap:8px;padding:5px 12px;background:rgba(0,230,118,0.12);
  border:1px solid rgba(0,230,118,0.3);border-radius:20px;font-size:12px;font-weight:600;color:#00e676}
.status-dot{width:7px;height:7px;border-radius:50%;background:#00e676;box-shadow:0 0 8px #00e676;animation:pulseDot 2s infinite ease-in-out}
.top-search{position:relative;width:240px}
.top-search input{width:100%;padding-left:32px;font-size:12.5px;height:34px;border-radius:18px;background:rgba(0,0,0,0.4)}

/* ── Timeframe Filters & Badges ────────────────────────────────────────── */
.timeframe-group{display:inline-flex;gap:6px;background:rgba(21,24,40,0.9);padding:4px;border-radius:10px;border:1px solid var(--line)}
.tf-btn{padding:6px 14px;font-size:12px;font-weight:600;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer;transition:all .18s ease}
.tf-btn:hover{color:var(--fg);background:rgba(255,255,255,0.04)}
.tf-btn.active{background:#1b2138;border-color:var(--cyan);color:#38bdf8;box-shadow:0 0 12px rgba(0,229,255,0.25)}
.tz-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid var(--line);font-size:12px;color:var(--muted);font-weight:500}

/* ── Sign-in ─────────────────────────────────────────────────────────────── */
.login{max-width:400px;margin:10vh auto;padding:36px;background:var(--panel);backdrop-filter:blur(16px);
  border:1px solid var(--line2);border-radius:16px;box-shadow:var(--shadow);animation:fadeIn .25s ease-out}
.login .mark{width:42px;height:42px;border-radius:12px;margin-bottom:18px;
  background:linear-gradient(135deg,#7c3aed,#00e5ff);
  display:flex;align-items:center;justify-content:center;color:#ffffff;font-weight:800;font-size:20px;box-shadow:0 4px 20px rgba(0,229,255,0.4)}
.login h1{font-size:22px;margin:0 0 6px;font-weight:700}
.login p{color:var(--muted);margin:0 0 22px;font-size:13.5px;line-height:1.55}
.login input{width:100%;margin-bottom:14px}
.login button{width:100%;padding:11px}
.err{color:var(--bad);font-size:13px;min-height:18px;margin-top:10px}

/* ── Shell & NEXIS Sidebar Layout ───────────────────────────────────────── */
.shell{display:grid;grid-template-columns:250px 1fr;min-height:100vh}
.side{background:#111422;backdrop-filter:blur(16px);border-right:1px solid var(--line);padding:20px 14px;
  display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:12px;padding:6px 10px 22px}
.brand .mark{width:36px;height:36px;border-radius:10px;flex:none;
  background:linear-gradient(135deg,#7c3aed,#00e5ff);
  display:flex;align-items:center;justify-content:center;color:#ffffff;font-weight:800;font-size:17px;box-shadow:0 4px 16px rgba(0,229,255,0.4)}
.brand b{display:block;font-size:15px;font-weight:800;letter-spacing:-.01em;line-height:1.25;
  background:linear-gradient(90deg,#00f2fe,#b854fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.brand small{display:block;color:var(--muted);font-weight:500;font-size:11px;line-height:1.3}

.nav-group-title{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;padding:14px 12px 6px;display:flex;align-items:center;gap:6px}
.nav-group-title.cyan-title{color:var(--cyan)}
.nav-group-title.purple-title{color:var(--purple)}
.nav-group-title.green-title{color:var(--green)}

.nav{display:flex;align-items:center;gap:11px;padding:9.5px 12px;border-radius:10px;
  color:var(--fg2);cursor:pointer;font-size:13.5px;font-weight:500;
  transition:all .15s ease;user-select:none;border:1.5px solid transparent}
.nav svg{width:18px;height:18px;flex:none;opacity:.8;transition:transform .15s}
.nav:hover{background:var(--panel2);color:var(--fg);transform:translateX(2px)}
.nav:hover svg{opacity:1;transform:scale(1.1)}
.nav.active{background:linear-gradient(135deg,rgba(124,58,237,0.28),rgba(0,229,255,0.14));
  color:#ffffff;border-color:var(--cyan);box-shadow:0 0 14px rgba(0,229,255,0.35);font-weight:600}
.nav.active svg{opacity:1;color:var(--cyan)}

.side .spacer{flex:1}
.side-foot{border-top:1px solid var(--line);padding-top:14px;margin-top:12px;display:flex;flex-direction:column;gap:8px}
.side-foot-item{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);font-weight:500}
.side-foot-item .dot{width:6px;height:6px;border-radius:50%}
.side-foot-item .dot.blue{background:var(--cyan);box-shadow:0 0 6px var(--cyan)}
.side-foot-item .dot.green{background:var(--green);box-shadow:0 0 6px var(--green)}
.mainnet-pill{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 12px;background:rgba(0,230,118,0.12);
  border:1px solid rgba(0,230,118,0.4);border-radius:20px;font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.6px;margin-top:4px}

.main{padding:24px 34px 60px;overflow:auto;min-width:0;animation:fadeIn .25s ease-out}
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.head h2{margin:0;font-size:26px;font-weight:800;background:linear-gradient(135deg,#00f2fe 0%,#b854fd 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}

/* ── NEXIS Metric Cards ─────────────────────────────────────────────────── */
.nexis-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.nexis-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px;
  position:relative;overflow:hidden;transition:all .2s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow:0 6px 20px rgba(0,0,0,0.35);backdrop-filter:blur(14px)}
.nexis-card:hover{transform:translateY(-3px);box-shadow:0 12px 30px rgba(0,0,0,0.5);border-color:rgba(0,229,255,0.4)}
.nexis-card.orders,.nexis-card.cyan{border-color:rgba(0,229,255,0.35)}
.nexis-card.amount,.nexis-card.green{border-color:rgba(0,230,118,0.35)}
.nexis-card.currencies,.nexis-card.purple{border-color:rgba(184,84,253,0.35)}
.nexis-card.blockchains,.nexis-card.orange{border-color:rgba(255,145,0,0.35)}
.nexis-card.bad{border-color:rgba(239,68,68,0.4)}

.nexis-card-head{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:10px}
.nexis-card-head .icon-box{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.05);font-size:14px}
.nexis-card.orders .icon-box,.nexis-card.cyan .icon-box{color:var(--cyan);border:1px solid rgba(0,229,255,0.3)}
.nexis-card.amount .icon-box,.nexis-card.green .icon-box{color:var(--green);border:1px solid rgba(0,230,118,0.3)}
.nexis-card.currencies .icon-box,.nexis-card.purple .icon-box{color:var(--purple);border:1px solid rgba(184,84,253,0.3)}
.nexis-card.blockchains .icon-box,.nexis-card.orange .icon-box{color:var(--orange);border:1px solid rgba(255,145,0,0.3)}
.nexis-card.bad .icon-box{color:var(--bad);border:1px solid rgba(239,68,68,0.4)}

.nexis-card-val{font-size:26px;font-weight:800;font-family:var(--display);font-variant-numeric:tabular-nums;letter-spacing:-.03em;color:#ffffff;margin-bottom:6px}
.nexis-card.amount .nexis-card-val,.nexis-card.green .nexis-card-val{color:var(--green)}
.nexis-card.cyan .nexis-card-val{color:#ffffff}
.nexis-card.purple .nexis-card-val{color:#e9d5ff}
.nexis-card.orange .nexis-card-val{color:#ffedd5}

.nexis-sub-item{margin-top:8px;font-size:12.5px;line-height:1.4}
.nexis-sub-title{font-weight:700;display:flex;align-items:center;gap:6px}
.nexis-sub-title.cyan{color:var(--cyan)}
.nexis-sub-title.orange{color:var(--orange)}
.nexis-sub-desc{color:var(--faint);font-size:11.5px;margin-top:2px}

/* Backward compatibility for legacy .cards container */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--panel);padding:18px 20px;border-radius:14px;border:var(--glass-border);backdrop-filter:blur(10px);
  box-shadow:0 6px 20px rgba(0,0,0,0.3);transition:all .2s ease}
.card:hover{transform:translateY(-2px);box-shadow:0 10px 25px rgba(0,0,0,0.4);border-color:rgba(0,229,255,0.3)}
.card .k{color:var(--muted);font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
.card .v{font-size:24px;font-weight:800;font-family:var(--display);color:#ffffff;font-variant-numeric:tabular-nums}
`;

export const UI_KIT_JS = String.raw`
// ── Money, labels, and NEXIS Gateway UI components ───────────────────────
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
      (sub?'<div class="nexis-sub-desc" style="margin-top:4px;font-weight:600;color:var(--'+(color==='bad'?'bad':color)+')">'+(typeof sub==='string'&&sub.indexOf('<')!==-1?sub:esc(String(sub)))+'</div>':'')+
    '</div>';
  }
  h += '</div>';
  return h;
}

function renderTimeframeSwitcher(active){
  active=active||'7 Days';
  var list=['Today','7 Days','30 Days','All Time'];
  var h='<div class="row"><div class="timeframe-group">';
  for(var i=0;i<list.length;i++){
    h+='<button class="tf-btn'+(list[i]===active?' active':'')+'" onclick="window.setTimeframe&&window.setTimeframe(\''+list[i]+'\')">'+list[i]+'</button>';
  }
  h+='</div><div class="tz-badge">🌐 UTC+3</div></div>';
  return h;
}

function renderSidebarFooter(){
  return '<div class="side-foot">'+
    '<div class="side-foot-item"><span class="dot blue"></span><span>v1.0.0</span></div>'+
    '<div class="side-foot-item"><span class="dot green"></span><span style="color:#00e676;font-weight:600;">ONLINE 21d 3h</span></div>'+
    '<div class="side-foot-item" style="font-size:11px;"><span style="color:#00e676;">CPU: 2.45%</span> <span style="color:#64748b;">|</span> <span style="color:#00e5ff;">RAM: 128MB</span></div>'+
    '<div class="mainnet-pill"><span class="status-dot"></span><span>MAINNET</span></div>'+
    '</div>';
}

function renderNexisCards(opts){
  opts=opts||{};
  var ordersVal=opts.ordersVal!=null?String(opts.ordersVal):'0';
  var amountVal=opts.amountVal!=null?String(opts.amountVal):'0.00 USD';
  var currenciesVal=opts.currenciesVal!=null?String(opts.currenciesVal):'0';
  var chainsVal=opts.chainsVal!=null?String(opts.chainsVal):'0';

  var payCount=opts.paymentsCount!=null?String(opts.paymentsCount):'0';
  var paySub=opts.paymentsSub||'0 paid, 0 pending, 0 expired';
  var donCount=opts.donationsCount!=null?String(opts.donationsCount):'0';
  var donSub=opts.donationsSub||'0 paid, 0 pending, 0 expired';

  var payAmt=opts.paymentsAmount!=null?String(opts.paymentsAmount):'0.00 USD';
  var donAmt=opts.donationsAmount!=null?String(opts.donationsAmount):'0.00 USD';

  return '<div class="nexis-cards">'+
    '<div class="nexis-card orders">'+
      '<div class="nexis-card-head"><div class="icon-box">📊</div><span>TOTAL ORDERS</span></div>'+
      '<div class="nexis-card-val">'+esc(ordersVal)+'</div>'+
      '<div class="nexis-sub-item">'+
        '<div class="nexis-sub-title cyan">'+esc(payCount)+' payments</div>'+
        '<div class="nexis-sub-desc">'+esc(paySub)+'</div>'+
      '</div>'+
      '<div class="nexis-sub-item">'+
        '<div class="nexis-sub-title orange">'+esc(donCount)+' payouts / donations</div>'+
        '<div class="nexis-sub-desc">'+esc(donSub)+'</div>'+
      '</div>'+
    '</div>'+
    '<div class="nexis-card amount">'+
      '<div class="nexis-card-head"><div class="icon-box">💲</div><span>TOTAL AMOUNT (USD)</span></div>'+
      '<div class="nexis-card-val">'+esc(amountVal)+'</div>'+
      '<div class="nexis-sub-item">'+
        '<div class="nexis-sub-title cyan">'+esc(payAmt)+' payments</div>'+
      '</div>'+
      '<div class="nexis-sub-item">'+
        '<div class="nexis-sub-title orange">'+esc(donAmt)+' payouts / donations</div>'+
      '</div>'+
    '</div>'+
    '<div class="nexis-card currencies">'+
      '<div class="nexis-card-head"><div class="icon-box">👛</div><span>CURRENCIES</span></div>'+
      '<div class="nexis-card-val">'+esc(currenciesVal)+'</div>'+
      '<div class="nexis-sub-desc" style="margin-top:6px;font-weight:600;color:var(--purple)">SUPPORTED ASSETS</div>'+
    '</div>'+
    '<div class="nexis-card blockchains">'+
      '<div class="nexis-card-head"><div class="icon-box">📦</div><span>BLOCKCHAINS</span></div>'+
      '<div class="nexis-card-val">'+esc(chainsVal)+'</div>'+
      '<div class="nexis-sub-desc" style="margin-top:6px;font-weight:600;color:var(--orange)">ACTIVE NETWORKS</div>'+
    '</div>'+
  '</div>';
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
        (hExp>0?'<div class="bar-seg expired" style="height:'+hExp+'px" title="Expired: '+(d.exp||0)+'"></div>':'')+
        (hPart>0?'<div class="bar-seg partial" style="height:'+hPart+'px" title="Partial: '+(d.part||0)+'"></div>':'')+
        (hPend>0?'<div class="bar-seg pending" style="height:'+hPend+'px" title="Pending: '+(d.pend||0)+'"></div>':'')+
        (hDon>0?'<div class="bar-seg donations" style="height:'+hDon+'px" title="Payouts/Donations: '+(d.don||0)+'"></div>':'')+
        (hPay>0?'<div class="bar-seg payments" style="height:'+hPay+'px" title="Payments: '+(d.pay||0)+'"></div>':'')+
      '</div>'+
      '<div class="bar-label">'+esc(d.day)+'</div>'+
    '</div>';
  }

  return '<div class="chart-panel">'+
    '<div class="chart-header">'+
      '<h3>Daily Activity (7 Days)</h3>'+
      '<div class="chart-legend">'+
        '<div class="legend-item"><span class="legend-dot" style="background:#00e676"></span><span>Payments</span></div>'+
        '<div class="legend-item"><span class="legend-dot" style="background:#ff9100"></span><span>Payouts / Donations</span></div>'+
        '<div class="legend-item"><span class="legend-dot" style="background:#2979ff"></span><span>Pending</span></div>'+
        '<div class="legend-item"><span class="legend-dot" style="background:#76ff03"></span><span>Partial</span></div>'+
        '<div class="legend-item"><span class="legend-dot" style="background:#64748b"></span><span>Expired</span></div>'+
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
  t.innerHTML='<span style="color:#2dd4bf;font-size:16px;">✓</span> <span>'+esc(msg)+'</span>';
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
