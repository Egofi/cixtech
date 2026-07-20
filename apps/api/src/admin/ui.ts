/**
 * The admin console SPA (ADR 0015), inlined so the API serves it with zero build
 * step and zero external dependencies (same self-contained posture as the rest of
 * the repo). The JS deliberately avoids template literals so it embeds safely in
 * this TS template string.
 */

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cixtech · admin</title>
<link rel="stylesheet" href="/admin/styles.css">
</head>
<body>
<div id="app"></div>
<script src="/admin/app.js"></script>
</body>
</html>`;

export const ADMIN_CSS = `
:root{
  --bg:#0e1116; --panel:#161b22; --panel2:#1c2430; --line:#2a3441;
  --fg:#e6edf3; --muted:#8b98a9; --accent:#4c9aff; --accent2:#2d6fd6;
  --ok:#3fb950; --warn:#d29922; --bad:#f85149; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--fg);border-radius:6px;padding:6px 12px}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent2);border-color:var(--accent2);color:#fff}
button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
button.danger:hover{background:rgba(248,81,73,.12)}
input{font:inherit;background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:8px 10px}
.login{max-width:360px;margin:14vh auto;padding:28px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
.login h1{font-size:18px;margin:0 0 4px} .login p{color:var(--muted);margin:0 0 18px;font-size:13px}
.login input{width:100%;margin-bottom:12px} .login button{width:100%}
.err{color:var(--bad);font-size:13px;min-height:18px;margin-top:8px}
.shell{display:grid;grid-template-columns:200px 1fr;min-height:100vh}
.side{background:var(--panel);border-right:1px solid var(--line);padding:16px 10px;display:flex;flex-direction:column;gap:2px}
.brand{font-weight:700;padding:8px 12px 16px;letter-spacing:.3px}
.brand small{display:block;color:var(--muted);font-weight:400;font-size:11px}
.nav{padding:9px 12px;border-radius:7px;color:var(--muted);cursor:pointer}
.nav:hover{background:var(--panel2);color:var(--fg)}
.nav.active{background:var(--panel2);color:var(--fg);box-shadow:inset 3px 0 0 var(--accent)}
.side .spacer{flex:1}
.main{padding:22px 26px;overflow:auto}
.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.head h2{margin:0;font-size:19px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.card .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}
.card .v{font-size:24px;font-weight:600;margin-top:4px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:20px}
.panel h3{margin:0;padding:12px 16px;font-size:13px;color:var(--muted);border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.4px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 16px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.3px}
tr:last-child td{border-bottom:none}
td.mono,.mono{font-family:var(--mono);font-size:12.5px}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11.5px;font-weight:600;border:1px solid}
.badge.ok{color:var(--ok);border-color:var(--ok)} .badge.warn{color:var(--warn);border-color:var(--warn)}
.badge.bad{color:var(--bad);border-color:var(--bad)} .badge.muted{color:var(--muted);border-color:var(--line)}
.muted{color:var(--muted)}
.actions button{padding:4px 9px;font-size:12px;margin-right:6px}
.empty{padding:26px;text-align:center;color:var(--muted)}
.detail{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:14px;margin:0 16px 16px;white-space:pre-wrap;word-break:break-all;font-family:var(--mono);font-size:12px}
.banner{padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600}
.banner.bad{background:rgba(248,81,73,.12);border:1px solid var(--bad);color:#ff9d97}
.banner.ok{background:rgba(63,185,80,.1);border:1px solid var(--ok);color:#7ee787}
`;

export const ADMIN_JS = String.raw`
(function(){
  var TK='cx_admin_token';
  var token=localStorage.getItem(TK);
  var view='overview';
  var root=document.getElementById('app');

  function esc(s){s=(s==null?'':String(s));return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function short(s){s=String(s||'');return s.length>14?s.slice(0,8)+'…'+s.slice(-4):s;}
  function when(s){if(!s)return'';var d=new Date(s);return isNaN(d)?esc(s):d.toISOString().replace('T',' ').slice(0,19);}
  function num(s){var n=String(s==null?'':s);return n.replace(/\B(?=(\d{3})+(?!\d))/g,',');}
  function logout(){localStorage.removeItem(TK);token=null;render();}

  function api(path,opts){
    opts=opts||{};
    opts.headers=Object.assign({'authorization':'Bearer '+token,'content-type':'application/json'},opts.headers||{});
    return fetch(path,opts).then(function(r){
      if(r.status===401){logout();throw new Error('Unauthorized');}
      return r.text().then(function(t){
        var b=t?JSON.parse(t):null;
        if(!r.ok){throw new Error((b&&b.error&&b.error.message)||('HTTP '+r.status));}
        return b;
      });
    });
  }

  function badge(text,cls){return '<span class="badge '+cls+'">'+esc(text)+'</span>';}
  function whStatusBadge(s){return badge(s,s==='delivered'?'ok':s==='dead'?'bad':'warn');}

  function table(cols,rows,rowFn){
    if(!rows||!rows.length)return '<div class="empty">Nothing here yet.</div>';
    var h='<table><thead><tr>';
    for(var i=0;i<cols.length;i++)h+='<th>'+esc(cols[i])+'</th>';
    h+='</tr></thead><tbody>';
    for(var j=0;j<rows.length;j++)h+='<tr>'+rowFn(rows[j])+'</tr>';
    return h+'</tbody></table>';
  }
  function panel(title,inner){return '<div class="panel"><h3>'+esc(title)+'</h3>'+inner+'</div>';}

  var NAV=[['overview','Overview'],['tenants','Tenants'],['ledger','Ledger'],['deposits','Deposits'],['payouts','Payouts'],['webhooks','Webhooks'],['audit','Admin audit'],['errors','Errors']];

  function render(){
    if(!token){renderLogin();return;}
    var nav='';
    for(var i=0;i<NAV.length;i++){nav+='<div class="nav'+(NAV[i][0]===view?' active':'')+'" data-nav="'+NAV[i][0]+'">'+NAV[i][1]+'</div>';}
    root.innerHTML='<div class="shell"><div class="side"><div class="brand">cixtech<small>super-admin</small></div>'+nav+'<div class="spacer"></div><button data-logout>Sign out</button></div><div class="main" id="main"><div class="empty">Loading…</div></div></div>';
    root.querySelectorAll('[data-nav]').forEach(function(n){n.onclick=function(){view=n.getAttribute('data-nav');render();};});
    root.querySelector('[data-logout]').onclick=logout;
    views[view]();
  }

  function renderLogin(){
    root.innerHTML='<div class="login"><h1>cixtech admin</h1><p>Enter the super-admin token to continue.</p><input id="tok" type="password" placeholder="Admin token" autocomplete="off"><button class="primary" id="go">Sign in</button><div class="err" id="le"></div></div>';
    var go=function(){var v=document.getElementById('tok').value.trim();if(!v)return;localStorage.setItem(TK,v);token=v;api('/admin/api/overview').then(function(){view='overview';render();}).catch(function(e){document.getElementById('le').textContent=e.message;localStorage.removeItem(TK);token=null;});};
    document.getElementById('go').onclick=go;
    document.getElementById('tok').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  }

  function main(html){document.getElementById('main').innerHTML=html;}
  function fail(e){main('<div class="banner bad">'+esc(e.message)+'</div>');}

  var views={};

  views.overview=function(){
    api('/admin/api/overview').then(function(d){
      var c=d.counts;
      var cards=[['Tenants',c.tenants],['Accounts',c.accounts],['Journal entries',c.entries],['Webhooks pending',c.webhooksPending],['Webhooks dead',c.webhooksDead],['Errors 24h',c.errors24h]];
      var cardsH='';for(var i=0;i<cards.length;i++)cardsH+='<div class="card"><div class="k">'+cards[i][0]+'</div><div class="v">'+num(cards[i][1])+'</div></div>';
      var ks=d.killSwitchEngaged;
      var banner=ks?'<div class="banner bad">Kill-switch ENGAGED — all payouts are halted.</div>':'<div class="banner ok">Kill-switch clear — payouts flowing normally.</div>';
      var solv=table(['Asset','Assets','Liabilities','Status'],d.solvency,function(r){
        return '<td class="mono">'+esc(r.asset)+'</td><td class="mono">'+num(r.assets)+'</td><td class="mono">'+num(r.liabilities)+'</td><td>'+(r.solvent?badge('solvent','ok'):badge('UNDER','bad'))+'</td>';
      });
      var lim=d.limits;
      var limits=panel('Money-out limits','<table><tbody><tr><td>Max per payout</td><td class="mono">'+num(lim.maxPerPayout)+'</td></tr><tr><td>Velocity window</td><td class="mono">'+num(lim.velocityWindowMs)+' ms</td></tr><tr><td>Velocity max</td><td class="mono">'+num(lim.velocityMax)+'</td></tr></tbody></table>');
      main('<div class="head"><h2>Overview</h2><div class="row">'+(ks?'<button class="primary" id="ksr">Reset kill-switch</button>':'<button class="danger" id="kse">Engage kill-switch</button>')+'</div></div>'+banner+'<div class="cards">'+cardsH+'</div>'+panel('Solvency (per asset)',solv)+limits);
      var e=document.getElementById('kse');if(e)e.onclick=function(){var reason=prompt('Reason for halting payouts?');if(reason==null)return;api('/admin/api/killswitch/engage',{method:'POST',body:JSON.stringify({reason:reason})}).then(views.overview).catch(fail);};
      var r=document.getElementById('ksr');if(r)r.onclick=function(){if(!confirm('Resume payouts?'))return;api('/admin/api/killswitch/reset',{method:'POST'}).then(views.overview).catch(fail);};
    }).catch(fail);
  };

  views.tenants=function(){
    api('/admin/api/tenants').then(function(rows){
      var t=table(['ID','Name','Accounts','API keys','Created'],rows,function(r){
        return '<td class="mono">'+short(r.id)+'</td><td>'+esc(r.name)+'</td><td>'+r.accounts+'</td><td>'+r.api_keys+'</td><td class="muted">'+when(r.created_at)+'</td>';
      });
      main('<div class="head"><h2>Tenants</h2><button class="primary" id="ct">New tenant</button></div>'+panel('All tenants',t));
      document.getElementById('ct').onclick=function(){var name=prompt('Tenant name?');if(!name)return;api('/admin/api/tenants',{method:'POST',body:JSON.stringify({name:name})}).then(function(res){alert('Tenant created.\nAPI key (shown once):\n'+res.apiKey);views.tenants();}).catch(fail);};
    }).catch(fail);
  };

  function entriesTable(rows){
    return table(['Kind','When','Postings','Idempotency'],rows,function(r){
      var p='';for(var i=0;i<r.postings.length;i++){var x=r.postings[i];p+='<div class="mono">'+(x.direction==='DEBIT'?'+':'-')+num(x.amount)+' '+esc(x.asset)+' · '+esc(x.account)+'</div>';}
      return '<td>'+badge(r.kind,r.kind.indexOf('reverse')===0?'warn':'muted')+'</td><td class="muted">'+when(r.occurred_at)+'</td><td>'+p+'</td><td class="mono muted">'+short(r.idempotency_key)+'</td>';
    });
  }
  views.ledger=function(){
    Promise.all([api('/admin/api/ledger/accounts'),api('/admin/api/ledger/entries?limit=50')]).then(function(res){
      var acc=table(['Account','Asset','Type','Balance'],res[0],function(r){return '<td class="mono">'+esc(r.account)+'</td><td class="mono">'+esc(r.asset)+'</td><td>'+badge(r.type,'muted')+'</td><td class="mono">'+num(r.balance)+'</td>';});
      main('<div class="head"><h2>Ledger</h2></div>'+panel('Balances',acc)+panel('Recent journal entries',entriesTable(res[1])));
    }).catch(fail);
  };
  views.deposits=function(){api('/admin/api/deposits?limit=80').then(function(rows){main('<div class="head"><h2>Deposits</h2></div>'+panel('Deposit journal entries',entriesTable(rows)));}).catch(fail);};
  views.payouts=function(){api('/admin/api/payouts?limit=80').then(function(rows){main('<div class="head"><h2>Payouts</h2></div>'+panel('Payout journal entries',entriesTable(rows)));}).catch(fail);};

  views.webhooks=function(){
    api('/admin/api/webhooks?limit=100').then(function(rows){
      var t=table(['ID','Tenant','Status','Attempts','Next attempt','Last error',''],rows,function(r){
        return '<td class="mono">'+short(r.id)+'</td><td class="mono">'+short(r.tenant_id)+'</td><td>'+whStatusBadge(r.status)+'</td><td>'+r.attempts+'</td><td class="muted">'+when(r.next_attempt)+'</td><td class="muted">'+esc(r.last_error||'')+'</td><td class="actions"><button data-insp="'+r.id+'">Inspect</button><button data-replay="'+r.id+'">Replay</button><button class="danger" data-cancel="'+r.id+'">Cancel</button></td>';
      });
      main('<div class="head"><h2>Webhook outbox</h2></div>'+panel('Deliveries',t)+'<div id="wdet"></div>');
      document.querySelectorAll('[data-replay]').forEach(function(b){b.onclick=function(){api('/admin/api/webhooks/'+b.getAttribute('data-replay')+'/replay',{method:'POST'}).then(views.webhooks).catch(fail);};});
      document.querySelectorAll('[data-cancel]').forEach(function(b){b.onclick=function(){if(!confirm('Dead-letter this delivery?'))return;api('/admin/api/webhooks/'+b.getAttribute('data-cancel')+'/cancel',{method:'POST'}).then(views.webhooks).catch(fail);};});
      document.querySelectorAll('[data-insp]').forEach(function(b){b.onclick=function(){api('/admin/api/webhooks/'+b.getAttribute('data-insp')).then(function(w){document.getElementById('wdet').innerHTML=panel('Delivery '+esc(w.id),'<div class="detail">'+esc(w.body)+'</div>');}).catch(fail);};});
    }).catch(fail);
  };

  views.audit=function(){
    api('/admin/api/audit?limit=120').then(function(rows){
      var t=table(['When','Actor','Action','Target','Result','Detail','IP'],rows,function(r){
        return '<td class="muted">'+when(r.at)+'</td><td>'+esc(r.actor)+'</td><td class="mono">'+esc(r.action)+'</td><td class="mono">'+esc(short(r.target||''))+'</td><td>'+(r.result==='ok'?badge('ok','ok'):badge('error','bad'))+'</td><td class="muted">'+esc(r.detail||'')+'</td><td class="mono muted">'+esc(r.ip||'')+'</td>';
      });
      main('<div class="head"><h2>Admin audit trail</h2></div>'+panel('Every control-plane action',t));
    }).catch(fail);
  };
  views.errors=function(){
    api('/admin/api/errors?limit=120').then(function(rows){
      var t=table(['When','Code','Message','ID'],rows,function(r){
        return '<td class="muted">'+when(r.at)+'</td><td>'+badge(r.code,'bad')+'</td><td>'+esc(r.message)+'</td><td class="mono muted">'+short(r.id)+'</td>';
      });
      main('<div class="head"><h2>Error trail</h2></div>'+panel('Captured errors (ADR 0012)',t));
    }).catch(fail);
  };

  render();
})();
`;
