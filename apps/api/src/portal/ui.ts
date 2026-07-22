/**
 * The tenant portal SPA — the dashboard a tenant signs into with their `cxk_` API
 * key. Inlined so the API serves it with zero build step and zero external
 * dependencies (same self-contained posture as the admin console, ADR 0015). The
 * JS deliberately avoids template literals so it embeds safely in this TS string.
 *
 * Trust model: the API key lives in localStorage and every data call hits the
 * normal `/v1` surface — the portal has no privileged endpoints of its own, so it
 * can do exactly what the API allows and nothing more. All §7 money-out guardrails
 * (limits, allow-list cool-down, velocity, kill-switch, solvency) act server-side.
 */

export const PORTAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cixtech · dashboard</title>
<link rel="stylesheet" href="/portal/styles.css">
</head>
<body>
<div id="app"></div>
<script src="/portal/app.js"></script>
</body>
</html>`;

export const PORTAL_CSS = `
:root{
  --bg:#0e1116; --panel:#161b22; --panel2:#1c2430; --line:#2a3441;
  --fg:#e6edf3; --muted:#8b98a9; --accent:#2dd4bf; --accent2:#0d9488;
  --ok:#3fb950; --warn:#d29922; --bad:#f85149; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--fg);border-radius:6px;padding:6px 12px}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent2);border-color:var(--accent2);color:#fff}
input,select{font:inherit;background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:8px 10px}
.login{max-width:380px;margin:14vh auto;padding:28px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
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
.empty{padding:26px;text-align:center;color:var(--muted)}
.form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;padding:14px 16px}
.form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.banner{padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600}
.banner.bad{background:rgba(248,81,73,.12);border:1px solid var(--bad);color:#ff9d97}
.banner.ok{background:rgba(63,185,80,.1);border:1px solid var(--ok);color:#7ee787}
.banner.warn{background:rgba(210,153,34,.1);border:1px solid var(--warn);color:#e3b341}
.secret{background:var(--panel2);border:1px dashed var(--warn);border-radius:8px;padding:12px 14px;margin:0 16px 16px;font-family:var(--mono);font-size:12.5px;word-break:break-all}
`;

export const PORTAL_JS = String.raw`
(function(){
  var TK='cx_tenant_key';
  var key=localStorage.getItem(TK);
  var view='overview';
  var root=document.getElementById('app');
  var flash=null; // one-shot banner {cls,msg} shown by the next screen render

  function esc(s){s=(s==null?'':String(s));return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function short(s){s=String(s||'');return s.length>18?s.slice(0,10)+'…'+s.slice(-5):s;}
  function when(s){if(!s)return'';var d=new Date(s);return isNaN(d)?esc(s):d.toISOString().replace('T',' ').slice(0,19);}
  function num(s){var n=String(s==null?'':s);return n.replace(/\B(?=(\d{3})+(?!\d))/g,',');}
  function logout(){localStorage.removeItem(TK);key=null;render();}

  function api(path,opts){
    opts=opts||{};
    opts.headers=Object.assign({'x-api-key':key,'content-type':'application/json'},opts.headers||{});
    return fetch(path,opts).then(function(r){
      if(r.status===401){logout();throw new Error('Unauthorized');}
      return r.text().then(function(t){
        var b=t?JSON.parse(t):null;
        if(!r.ok){var e=new Error((b&&b.error&&b.error.message)||('HTTP '+r.status));e.code=b&&b.error&&b.error.code;throw e;}
        return b;
      });
    });
  }

  function badge(text,cls){return '<span class="badge '+cls+'">'+esc(text)+'</span>';}
  function payoutBadge(s){return badge(s,s==='settled'?'ok':s==='failed'?'bad':'warn');}
  function whBadge(s){return badge(s,s==='delivered'?'ok':s==='dead'?'bad':'warn');}

  function table(cols,rows,rowFn){
    if(!rows||!rows.length)return '<div class="empty">Nothing here yet.</div>';
    var h='<table><thead><tr>';
    for(var i=0;i<cols.length;i++)h+='<th>'+esc(cols[i])+'</th>';
    h+='</tr></thead><tbody>';
    for(var j=0;j<rows.length;j++)h+='<tr>'+rowFn(rows[j])+'</tr>';
    return h+'</tbody></table>';
  }
  function panel(title,inner){return '<div class="panel"><h3>'+esc(title)+'</h3>'+inner+'</div>';}
  function accountOptions(accounts){
    var h='';for(var i=0;i<accounts.length;i++){var a=accounts[i];h+='<option value="'+esc(a.id)+'">'+esc(a.externalRef||short(a.id))+'</option>';}
    return h;
  }
  function chainOptions(chains){var h='';for(var i=0;i<chains.length;i++)h+='<option>'+esc(chains[i])+'</option>';return h;}

  var NAV=[['overview','Overview'],['accounts','Accounts'],['deposits','Deposits'],['payouts','Payouts'],['allowlist','Allow-list'],['webhooks','Webhooks']];

  function render(){
    if(!key){renderLogin();return;}
    var nav='';
    for(var i=0;i<NAV.length;i++){nav+='<div class="nav'+(NAV[i][0]===view?' active':'')+'" data-nav="'+NAV[i][0]+'">'+NAV[i][1]+'</div>';}
    root.innerHTML='<div class="shell"><div class="side"><div class="brand">cixtech<small>tenant dashboard</small></div>'+nav+'<div class="spacer"></div><a class="nav" href="/docs" target="_blank">API docs ↗</a><button data-logout>Sign out</button></div><div class="main" id="main"><div class="empty">Loading…</div></div></div>';
    root.querySelectorAll('[data-nav]').forEach(function(n){n.onclick=function(){view=n.getAttribute('data-nav');render();};});
    root.querySelector('[data-logout]').onclick=logout;
    views[view]();
  }

  function renderLogin(){
    root.innerHTML='<div class="login"><h1>cixtech dashboard</h1><p>Sign in with your tenant API key (the <span class="mono">cxk_…</span> value issued when your tenant was created).</p><input id="tok" type="password" placeholder="cxk_…" autocomplete="off"><button class="primary" id="go">Sign in</button><div class="err" id="le"></div></div>';
    var go=function(){var v=document.getElementById('tok').value.trim();if(!v)return;key=v;api('/v1/accounts').then(function(){localStorage.setItem(TK,v);view='overview';render();}).catch(function(e){key=null;document.getElementById('le').textContent=e.message;});};
    document.getElementById('go').onclick=go;
    document.getElementById('tok').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  }

  function main(html){
    var f='';
    if(flash){f='<div class="banner '+flash.cls+'">'+esc(flash.msg)+'</div>';flash=null;}
    document.getElementById('main').innerHTML=f+html;
  }
  function fail(e){main('<div class="banner bad">'+esc(e.message)+'</div>');}
  function friendly(e){
    var m=e.message;
    if(e.code==='POLICY_DENIED')m='Denied by policy: '+e.message;
    else if(e.code==='POLICY_APPROVAL_REQUIRED')m='Held for approval: '+e.message;
    else if(e.code==='POLICY_TIME_LOCKED')m='Time-locked: '+e.message;
    else if(e.code==='POLICY_COMPLIANCE_HOLD')m='Compliance hold: '+e.message;
    else if(e.code==='LEDGER_INSUFFICIENT_FUNDS')m='Insufficient available balance: '+e.message;
    else if(e.code==='POOL_INSUFFICIENT_FUNDS')m='On-chain funds not yet gathered: '+e.message;
    return m;
  }

  var views={};

  views.overview=function(){
    Promise.all([api('/v1/accounts'),api('/v1/balances'),api('/v1/payouts?limit=8'),api('/v1/deposits?limit=8')]).then(function(res){
      var accounts=res[0].accounts,balances=res[1].balances,payouts=res[2].payouts,deposits=res[3].deposits;
      var pend=0;for(var i=0;i<payouts.length;i++)if(payouts[i].status!=='settled'&&payouts[i].status!=='failed')pend++;
      var cards=[['Accounts',accounts.length],['Balances held',balances.length],['Payouts in flight',pend],['Recent deposits',deposits.length]];
      var cardsH='';for(var j=0;j<cards.length;j++)cardsH+='<div class="card"><div class="k">'+cards[j][0]+'</div><div class="v">'+num(cards[j][1])+'</div></div>';
      var bal=table(['Account','Asset','Available (base units)'],balances,function(r){
        return '<td class="mono">'+short(r.accountId)+'</td><td class="mono">'+esc(r.asset)+'</td><td class="mono">'+num(r.available)+'</td>';
      });
      var dep=table(['When','Kind','Asset','Amount','Account'],deposits,function(r){
        return '<td class="muted">'+when(r.occurredAt)+'</td><td>'+badge(r.kind,r.kind.indexOf('reverse')===0?'warn':r.kind==='deposit.quarantined'?'bad':'muted')+'</td><td class="mono">'+esc(r.asset)+'</td><td class="mono">'+num(r.amount)+'</td><td class="mono">'+short(r.accountId||'—')+'</td>';
      });
      var pay=table(['When','Status','Asset','Amount','Destination'],payouts,function(r){
        return '<td class="muted">'+when(r.createdAt)+'</td><td>'+payoutBadge(r.status)+'</td><td class="mono">'+esc(r.asset)+'</td><td class="mono">'+num(r.amount)+'</td><td class="mono">'+short(r.destination)+'</td>';
      });
      main('<div class="head"><h2>Overview</h2></div><div class="cards">'+cardsH+'</div>'+panel('Available balances',bal)+panel('Recent deposits',dep)+panel('Recent payouts',pay));
    }).catch(fail);
  };

  views.accounts=function(){
    api('/v1/accounts').then(function(d){
      var t=table(['ID','Reference','Created',''],d.accounts,function(r){
        return '<td class="mono">'+esc(r.id)+'</td><td>'+esc(r.externalRef||'')+'</td><td class="muted">'+when(r.createdAt)+'</td><td><button data-addr="'+esc(r.id)+'">Deposit addresses</button></td>';
      });
      main('<div class="head"><h2>Accounts</h2><button class="primary" id="ca">New account</button></div>'+panel('Your sub-accounts',t)+'<div id="adet"></div>');
      document.getElementById('ca').onclick=function(){
        var ref=prompt('External reference for the new account (e.g. your merchant id)?');
        if(ref==null)return;
        api('/v1/accounts',{method:'POST',body:JSON.stringify(ref?{externalRef:ref}:{})}).then(function(){flash={cls:'ok',msg:'Account created.'};views.accounts();}).catch(fail);
      };
      document.querySelectorAll('[data-addr]').forEach(function(b){b.onclick=function(){showAddresses(b.getAttribute('data-addr'));};});
    }).catch(fail);
  };

  function showAddresses(accountId){
    Promise.all([api('/v1/accounts/'+accountId+'/deposit-addresses'),api('/v1/chains')]).then(function(res){
      var t=table(['Chain','Address','State','Cooling until'],res[0].addresses,function(r){
        return '<td class="mono">'+esc(r.chain)+'</td><td class="mono">'+esc(r.address)+'</td><td>'+badge(r.state,r.state==='AVAILABLE'?'ok':'warn')+'</td><td class="muted">'+when(r.cooldownUntil)+'</td>';
      });
      var form='<div class="form"><label>Chain<select id="gc">'+chainOptions(res[1].chains)+'</select></label><label>Asset<input id="ga" value="USDT" size="8"></label><button class="primary" id="gen">Generate address</button></div>';
      document.getElementById('adet').innerHTML=panel('Deposit addresses · '+short(accountId),form+t);
      document.getElementById('gen').onclick=function(){
        api('/v1/accounts/'+accountId+'/deposit-addresses',{method:'POST',body:JSON.stringify({chain:document.getElementById('gc').value,asset:document.getElementById('ga').value})})
          .then(function(r){flash={cls:'ok',msg:'Address assigned: '+r.address};views.accounts();}).catch(fail);
      };
    }).catch(fail);
  }

  views.deposits=function(){
    api('/v1/deposits?limit=100').then(function(d){
      var t=table(['When','Kind','Asset','Amount (base units)','Account','Entry'],d.deposits,function(r){
        return '<td class="muted">'+when(r.occurredAt)+'</td><td>'+badge(r.kind,r.kind.indexOf('reverse')===0?'warn':r.kind==='deposit.quarantined'?'bad':'muted')+'</td><td class="mono">'+esc(r.asset)+'</td><td class="mono">'+num(r.amount)+'</td><td class="mono">'+short(r.accountId||'—')+'</td><td class="mono muted">'+short(r.id)+'</td>';
      });
      main('<div class="head"><h2>Deposits</h2></div>'+panel('Credits at finality · quarantines · reorg reversals',t));
    }).catch(fail);
  };

  views.payouts=function(){
    Promise.all([api('/v1/payouts?limit=100'),api('/v1/accounts'),api('/v1/chains')]).then(function(res){
      var t=table(['When','Status','Chain','Asset','Amount','Destination','Tx'],res[0].payouts,function(r){
        return '<td class="muted">'+when(r.createdAt)+'</td><td>'+payoutBadge(r.status)+'</td><td class="mono">'+esc(r.chain)+'</td><td class="mono">'+esc(r.asset)+'</td><td class="mono">'+num(r.amount)+'</td><td class="mono">'+short(r.destination)+'</td><td class="mono muted">'+short(r.txId||'')+'</td>';
      });
      var form='<div class="form">'
        +'<label>Account<select id="pa">'+accountOptions(res[1].accounts)+'</select></label>'
        +'<label>Chain<select id="pc">'+chainOptions(res[2].chains)+'</select></label>'
        +'<label>Asset<input id="ps" value="USDT" size="8"></label>'
        +'<label>Amount (base units)<input id="pm" size="16"></label>'
        +'<label>Destination<input id="pd" size="36" placeholder="allow-listed address"></label>'
        +'<button class="primary" id="send">Request payout</button></div>'
        +'<div class="empty" style="padding:8px 16px;text-align:left">Destinations must be allow-listed and past their cool-down. Limits, velocity caps, and the kill-switch apply server-side.</div>';
      main('<div class="head"><h2>Payouts</h2></div>'+panel('Request a payout',form)+panel('History',t));
      document.getElementById('send').onclick=function(){
        var acc=document.getElementById('pa').value,amt=document.getElementById('pm').value.trim(),dst=document.getElementById('pd').value.trim();
        if(!acc||!amt||!dst){flash={cls:'warn',msg:'Account, amount, and destination are required.'};views.payouts();return;}
        api('/v1/accounts/'+acc+'/withdrawals',{method:'POST',headers:{'idempotency-key':(crypto.randomUUID?crypto.randomUUID():String(Date.now()))},body:JSON.stringify({chain:document.getElementById('pc').value,asset:document.getElementById('ps').value,amount:amt,destination:dst})})
          .then(function(r){flash={cls:'ok',msg:'Payout settled. Tx: '+r.txId};views.payouts();})
          .catch(function(e){flash={cls:e.code==='POLICY_APPROVAL_REQUIRED'||e.code==='POLICY_TIME_LOCKED'?'warn':'bad',msg:friendly(e)};views.payouts();});
      };
    }).catch(fail);
  };

  views.allowlist=function(){
    Promise.all([api('/v1/allowlist?limit=100'),api('/v1/accounts'),api('/v1/chains')]).then(function(res){
      var now=Date.now();
      var t=table(['Added','Account','Chain','Address','Usable'],res[0].allowlist,function(r){
        var cooling=new Date(r.usableAt).getTime()>now;
        return '<td class="muted">'+when(r.addedAt)+'</td><td class="mono">'+short(r.accountId)+'</td><td class="mono">'+esc(r.chain)+'</td><td class="mono">'+esc(r.address)+'</td><td>'+(cooling?badge('cooling until '+when(r.usableAt),'warn'):badge('usable','ok'))+'</td>';
      });
      var form='<div class="form">'
        +'<label>Account<select id="aa">'+accountOptions(res[1].accounts)+'</select></label>'
        +'<label>Chain<select id="ac">'+chainOptions(res[2].chains)+'</select></label>'
        +'<label>Address<input id="ad" size="36"></label>'
        +'<button class="primary" id="add">Add destination</button></div>'
        +'<div class="empty" style="padding:8px 16px;text-align:left">New destinations are unusable until their cool-down elapses — this is what stops an attacker who adds their own address from draining in the same session.</div>';
      main('<div class="head"><h2>Payout allow-list</h2></div>'+panel('Add a destination',form)+panel('Destinations',t));
      document.getElementById('add').onclick=function(){
        var acc=document.getElementById('aa').value,addr=document.getElementById('ad').value.trim();
        if(!acc||!addr){flash={cls:'warn',msg:'Account and address are required.'};views.allowlist();return;}
        api('/v1/accounts/'+acc+'/allowlist',{method:'POST',body:JSON.stringify({chain:document.getElementById('ac').value,address:addr})})
          .then(function(r){flash={cls:'ok',msg:'Added. Usable from '+when(r.usableAt)+'.'};views.allowlist();})
          .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.allowlist();});
      };
    }).catch(fail);
  };

  views.webhooks=function(){
    Promise.all([api('/v1/webhook'),api('/v1/webhook/deliveries?limit=100')]).then(function(res){
      var cfg='<div class="form"><label>Endpoint URL<input id="wu" size="46" value="'+esc(res[0].url||'')+'" placeholder="https://your-app.example/webhooks"></label><button class="primary" id="ws">Save endpoint</button></div>'
        +'<div class="empty" style="padding:8px 16px;text-align:left">Saving issues a fresh HMAC secret (shown once). Verify deliveries with the <span class="mono">x-cixtech-signature</span> header.</div><div id="wsec"></div>';
      var t=table(['When','Event','Status','Attempts','Last error'],res[1].deliveries,function(r){
        return '<td class="muted">'+when(r.createdAt)+'</td><td class="mono">'+esc(r.event)+'</td><td>'+whBadge(r.status)+'</td><td>'+r.attempts+'</td><td class="muted">'+esc(r.lastError||'')+'</td>';
      });
      main('<div class="head"><h2>Webhooks</h2></div>'+panel('Endpoint',cfg)+panel('Delivery history',t));
      document.getElementById('ws').onclick=function(){
        var url=document.getElementById('wu').value.trim();
        if(!url){flash={cls:'warn',msg:'Endpoint URL is required.'};views.webhooks();return;}
        api('/v1/webhook',{method:'PUT',body:JSON.stringify({url:url})})
          .then(function(r){document.getElementById('wsec').innerHTML='<div class="secret">Webhook secret (shown once — store it now):<br>'+esc(r.secret)+'</div>';})
          .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.webhooks();});
      };
    }).catch(fail);
  };

  render();
})();
`;
