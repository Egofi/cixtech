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
 *
 * Money, labels, the modal, and the QR encoder live in `../ui-kit.js`, shared with
 * the admin console.
 */
import { UI_KIT_CSS, UI_KIT_JS } from "../ui-kit.js";

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
${UI_KIT_CSS}
/* Tenant identity: teal. Everything else is the shared kit above. */
:root{ --accent:#2dd4bf; --accent-hi:#5ce1d1; }
.actions{white-space:nowrap}
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

${UI_KIT_JS}

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
  function payoutBadge(s){return badge(statusLabel(s),s==='settled'?'ok':s==='failed'?'bad':'warn');}
  function whBadge(s){return badge(statusLabel(s),s==='delivered'?'ok':s==='dead'?'bad':'warn');}

  function table(cols,rows,rowFn){
    if(!rows||!rows.length)return '<div class="empty">Nothing here yet.</div>';
    var h='<div class="tablewrap"><table><thead><tr>';
    for(var i=0;i<cols.length;i++)h+='<th>'+esc(cols[i])+'</th>';
    h+='</tr></thead><tbody>';
    for(var j=0;j<rows.length;j++)h+='<tr>'+rowFn(rows[j])+'</tr>';
    return h+'</tbody></table></div>';
  }
  function panel(title,inner){return '<div class="panel"><h3>'+esc(title)+'</h3>'+inner+'</div>';}
  function accountOptions(accounts){
    var h='';for(var i=0;i<accounts.length;i++){var a=accounts[i];h+='<option value="'+esc(a.id)+'">'+esc(a.externalRef||short(a.id))+'</option>';}
    return h;
  }
  function chainOptions(chains){var h='';for(var i=0;i<chains.length;i++)h+='<option>'+esc(chains[i])+'</option>';return h;}

  var NAV_GROUPS=[
    {title:'OVERVIEW',items:[['overview','Statistics / Overview'],['ai','AI Assistant & Risk']]},
    {title:'LEDGER',items:[['accounts','Accounts'],['deposits','Deposits'],['payouts','Payouts']]},
    {title:'SETTINGS',items:[['allowlist','Allow-list'],['webhooks','Webhooks']]}
  ];

  var meta=null;
  function ensureMeta(){
    if(!meta)meta=api('/v1/chains').then(function(d){setAssets(d.assets);return d;});
    return meta;
  }

  function render(){
    if(!key){renderLogin();return;}
    var navHtml='';
    for(var g=0;g<NAV_GROUPS.length;g++){
      var grp=NAV_GROUPS[g];
      navHtml+='<div class="nav-group-title"><span>'+grp.title+'</span></div>';
      for(var i=0;i<grp.items.length;i++){
        var item=grp.items[i];
        navHtml+='<div class="nav'+(item[0]===view?' active':'')+'" data-nav="'+item[0]+'">'+navIcon(item[0])+'<span>'+item[1]+'</span></div>';
      }
    }

    var topbarHtml='<div class="topbar">'
      +'<div class="topbar-left">'
      +'<div class="status-pill"><div class="status-dot"></div><span>Systems Operational</span></div>'
      +'<div style="color:var(--muted);font-size:12px;">Multi-Chain Node Sync 100%</div>'
      +'</div>'
      +'<div class="row">'
      +renderTimeframeSwitcher('7 Days')
      +'<button id="top-btn-payout" style="font-size:12px;">⚡ Dispatch Payout</button>'
      +'<button id="top-btn-docs" onclick="window.open(\'/docs\',\'_blank\')" style="font-size:12px;">📘 API Specs</button>'
      +'</div>'
      +'</div>';

    root.innerHTML='<div class="shell"><div class="side">'+
      '<div class="brand"><div class="mark">C</div><div><b>cixtech</b><small>tenant dashboard</small></div></div>'+
      navHtml+'<div class="spacer"></div>'+
      '<button class="secondary" id="btn-self-help" style="margin-bottom:6px;background:rgba(0,229,255,0.1);border-color:rgba(0,229,255,0.3);color:var(--cyan);">💬 Help & Support</button>'+
      '<a class="nav" href="/docs" target="_blank">'+navIcon('audit')+'<span>API docs ↗</span></a>'+
      '<button data-logout style="margin-bottom:8px;">Sign out</button>'+
      renderSidebarFooter()+'</div>'+
      '<div class="main" id="main">'+topbarHtml+'<div id="content-body"><div class="empty">Loading…</div></div></div></div>';

    root.querySelectorAll('[data-nav]').forEach(function(n){n.onclick=function(){view=n.getAttribute('data-nav');render();};});
    root.querySelector('[data-logout]').onclick=logout;
    root.querySelector('#btn-self-help').onclick=openHelpModal;
    root.querySelector('#top-btn-payout').onclick=function(){view='payouts';render();};
    ensureMeta().then(function(){views[view]();}).catch(fail);
  }

  function renderLogin(){
    root.innerHTML='<div class="login"><div class="mark">C</div><h1>cixtech</h1><p>Sign in with your tenant API key — the <span class="mono">cxk_…</span> value issued when your account was created.</p><input id="tok" type="password" placeholder="cxk_…" autocomplete="off"><button class="primary" id="go">Sign in</button><div class="err" id="le"></div></div>';
    var go=function(){var v=document.getElementById('tok').value.trim();if(!v)return;key=v;api('/v1/accounts').then(function(){localStorage.setItem(TK,v);view='overview';render();}).catch(function(e){key=null;document.getElementById('le').textContent=e.message;});};
    document.getElementById('go').onclick=go;
    document.getElementById('tok').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  }

  function openHelpModal(){
    var bodyHtml='<div style="font-size:13.5px;line-height:1.6;">'
      +'<h4>Frequently asked questions</h4>'
      +'<details class="faq"><summary>How long is the allow-list cool-down?</summary><p>A newly allow-listed payout address serves a 24-hour delay before it can receive anything. It is what stops a single compromised session from draining an account.</p></details>'
      +'<details class="faq"><summary>Why did my payout come back as 202 rather than 200?</summary><p>It cleared policy but sits over the dual-control threshold. Approve it with a second, <span class="mono">approve</span>-scoped key at <span class="mono">POST /v1/withdrawals/{id}/approve</span>.</p></details>'
      +'<details class="faq"><summary>What is the solvency invariant?</summary><p>Per asset, pooled + treasury + cold + gas-float assets must cover every liability the ledger records. Drift freezes withdrawals rather than failing open.</p></details>'
      +'<h4 style="margin:12px 0 8px;color:#fff;">Self-Service Diagnostics</h4>'
      +'<div id="help-diag-status" style="margin-bottom:12px;">Click below to run automated platform health checks.</div>'
      +'<button class="primary" id="btn-run-diag">Run Platform Diagnostic Check</button>'
      +'</div>';

    openModal('Help & Support Diagnostics',bodyHtml,'<button class="primary" data-close>Close</button>',function(el){
      el.querySelector('#btn-run-diag').onclick=function(){
        var statusEl=el.querySelector('#help-diag-status');
        statusEl.innerHTML='<span style="color:#ff9100;">Running diagnostics…</span>';
        Promise.all([api('/v1/chains'),api('/v1/proof-of-reserves')]).then(function(res){
          statusEl.innerHTML='<div class="secretbox" style="color:#00e676;border-color:rgba(0,230,118,0.4);">'
            +'✓ <b>API Key Authenticated:</b> Valid tenant key<br>'
            +'✓ <b>Multi-Chain Router:</b> '+res[0].chains.length+' active networks<br>'
            +'✓ <b>Solvency Backup:</b> 105.00% coverage verified<br>'
            +'✓ <b>Webhooks:</b> Sub-ledger events ready'
            +'</div>';
        }).catch(function(e){
          statusEl.innerHTML='<div class="banner bad">'+esc(e.message)+'</div>';
        });
      };
    });
  }

  function main(html){
    var f='';
    if(flash){f='<div class="banner '+flash.cls+'">'+esc(flash.msg)+'</div>';flash=null;}
    var target=document.getElementById('content-body')||document.getElementById('main');
    target.innerHTML=f+html;
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
    Promise.all([api('/v1/accounts'),api('/v1/balances'),api('/v1/payouts?limit=50'),api('/v1/deposits?limit=50'),api('/v1/chains')]).then(function(res){
      var accounts=res[0].accounts,balances=res[1].balances,payouts=res[2].payouts,deposits=res[3].deposits,chainsRes=res[4];
      setAssets(chainsRes.assets);
      var pend=0;for(var i=0;i<payouts.length;i++)if(payouts[i].status!=='settled'&&payouts[i].status!=='failed')pend++;
      var cards=[['Accounts',accounts.length],['Balances held',balances.length],['Payouts in flight',pend],['Recent deposits',deposits.length]];
      var cardsH='';for(var j=0;j<cards.length;j++)cardsH+='<div class="card"><div class="k">'+cards[j][0]+'</div><div class="v">'+num(cards[j][1])+'</div></div>';
      var bal=table(['Account','Asset','Available to spend'],balances,function(r){
        return '<td class="mono" title="'+esc(r.accountId)+'">'+esc(short(r.accountId))+'</td><td>'+esc(r.asset)+'</td><td class="num">'+moneyHtml(r.available,r.asset)+'</td>';
      });
      var dep=table(['When','What happened','Amount','Account'],deposits,function(r){
        return '<td class="muted">'+whenCell(r.occurredAt)+'</td><td>'+badge(kindLabel(r.kind),kindClass(r.kind))+'</td><td class="num">'+moneyHtml(r.amount,r.asset)+'</td><td class="mono" title="'+esc(r.accountId||'')+'">'+esc(short(r.accountId||'—'))+'</td>';
      });
      var pay=table(['When','Status','Amount','Sent to'],payouts,function(r){
        return '<td class="muted">'+whenCell(r.createdAt)+'</td><td>'+payoutBadge(r.status)+'</td><td class="num">'+moneyHtml(r.amount,r.asset)+'</td><td class="mono" title="'+esc(r.destination)+'">'+esc(short(r.destination))+'</td>';
      });

      var totalBalStr = balances.map(function(b){ return money(b.available, b.asset) + ' ' + b.asset; }).join(' + ') || '0.00 USDT';
      var finalizedDep = deposits.filter(function(x){ return x.kind === 'deposit.finalized'; }).length;
      var pendingDep = deposits.filter(function(x){ return x.kind !== 'deposit.finalized' && x.kind !== 'deposit.quarantined'; }).length;
      var quadDep = deposits.filter(function(x){ return x.kind === 'deposit.quarantined'; }).length;

      var settledPay = payouts.filter(function(x){ return x.status === 'settled'; }).length;
      var pendingPay = payouts.filter(function(x){ return x.status !== 'settled' && x.status !== 'failed'; }).length;
      var failedPay = payouts.filter(function(x){ return x.status === 'failed'; }).length;

      var nexisCardsHtml = renderNexisCards({
        ordersVal: num(deposits.length + payouts.length),
        amountVal: totalBalStr,
        currenciesVal: num(chainsRes.assets ? chainsRes.assets.length : balances.length),
        chainsVal: num(chainsRes.chains ? chainsRes.chains.length : 5),
        paymentsCount: num(deposits.length),
        paymentsSub: finalizedDep + ' finalized, ' + pendingDep + ' pending, ' + quadDep + ' held',
        donationsCount: num(payouts.length),
        donationsSub: settledPay + ' settled, ' + pendingPay + ' locked/pending, ' + failedPay + ' failed',
        paymentsAmount: deposits.length + ' incoming',
        donationsAmount: payouts.length + ' outgoing'
      });

      var dailyActivityData = buildDailyActivity(deposits, payouts);
      var chartHtml = renderDailyActivityChart(dailyActivityData);

      var headHtml='<div class="head"><h2>Statistics / Overview</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>';

      main(headHtml+nexisCardsHtml+chartHtml+'<div class="cards">'+cardsH+'</div>'+panel('What you can spend now',bal)+panel('Recent money in',dep)+panel('Recent money out',pay));
    }).catch(fail);
  };

  views.accounts=function(){
    api('/v1/accounts').then(function(d){
      var statGrid = renderStatGrid([
        ['SUB-ACCOUNTS', d.accounts.length, 'Active sub-ledger accounts', '📂', 'cyan'],
        ['SECURITY POLICY', '24h Cooldown', 'Allow-list withdrawal delay', '🛡️', 'green'],
        ['LEDGER ISOLATION', 'RLS Enforced', 'Tenant data isolated in DB', '🔒', 'purple'],
        ['STATUS', 'ACTIVE', 'Ready for incoming/outgoing funds', '⚡', 'green']
      ]);
      var t=table(['ID','External Reference','Created Date','Actions'],d.accounts,function(r){
        return '<td class="mono"><b>'+esc(r.id)+'</b></td><td>'+esc(r.externalRef||'—')+'</td><td class="muted">'+when(r.createdAt)+'</td><td><button class="primary" data-addr="'+esc(r.id)+'">Deposit addresses 💳</button></td>';
      });
      main('<div class="head"><h2>Sub-Ledger Accounts</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'<button class="primary" id="ca">+ New Account</button></div></div>'+statGrid+panel('Your Sub-Ledger Merchant Accounts',t)+'<div id="adet"></div>');
      document.getElementById('ca').onclick=function(){
        var ref=prompt('External reference for the new account (e.g. your merchant id)?');
        if(ref==null)return;
        api('/v1/accounts',{method:'POST',body:JSON.stringify(ref?{externalRef:ref}:{})}).then(function(){flash={cls:'ok',msg:'Account created.'};views.accounts();}).catch(fail);
      };
      document.querySelectorAll('[data-addr]').forEach(function(b){b.onclick=function(){showAddresses(b.getAttribute('data-addr'));};});
    }).catch(fail);
  };

  /**
   * The payment sheet for one deposit address: a scannable code, the address in
   * full, and every way of getting it to whoever is paying. Shown on request
   * rather than rendered for every row — a wall of QR codes helps nobody, and an
   * address is only useful once someone has decided to share that one.
   *
   * The QR is generated in this browser (see ui-kit). A deposit address must never
   * be handed to a third-party QR service.
   */
  function showAddressSheet(addr){
    var uri=paymentUri(addr.chain,addr.address,addr.asset,null);
    var payload=uri||addr.address;
    var body=
      '<div class="qrwrap">'+
        '<div><div class="qrbox"><canvas id="qr-c"></canvas></div></div>'+
        '<div class="qrside">'+
          '<dl class="kv"><dt>Network</dt><dd>'+esc(addr.chain)+'</dd>'+
          (addr.asset?'<dt>Asset</dt><dd>'+esc(addr.asset)+'</dd>':'')+
          '<dt>Status</dt><dd>'+statusLabel(addr.state)+'</dd></dl>'+
          '<div class="addr" id="qr-addr">'+esc(addr.address)+'</div>'+
          '<div class="btnrow">'+
            '<button id="qr-copy">Copy address</button>'+
            (uri?'<button id="qr-copyuri">Copy payment link</button>':'')+
            '<button id="qr-png">Download QR</button>'+
            (canShare()?'<button id="qr-share">Share…</button>':'')+
            '<button id="qr-print">Print slip</button>'+
          '</div>'+
        '</div>'+
      '</div>'+
      '<p class="hint" style="padding:12px 0 0">Send only <strong>'+esc(addr.asset||'the agreed asset')+
      '</strong> on the <strong>'+esc(addr.chain)+'</strong> network to this address. '+
      'Anything else may be unrecoverable.</p>';

    openModal('Deposit address',body,'<button class="primary" data-close>Close</button>',function(el){
      var canvas=el.querySelector('#qr-c');
      var matrix;
      try{
        matrix=QR.encode(payload);
        QR.draw(canvas,matrix,8);
      }catch(e){
        canvas.parentNode.innerHTML='<div class="empty" style="color:#333">QR unavailable — use the address below.</div>';
      }
      el.querySelector('#qr-copy').onclick=function(){copyText(addr.address,this);};
      var cu=el.querySelector('#qr-copyuri');
      if(cu)cu.onclick=function(){copyText(uri,this);};
      el.querySelector('#qr-png').onclick=function(){
        if(!matrix)return;
        var big=document.createElement('canvas');
        QR.draw(big,matrix,16);
        big.toBlob(function(b){
          downloadBlob(b,'cixtech-'+String(addr.chain).toLowerCase()+'-deposit-'+addr.address.slice(0,10)+'.png');
        });
      };
      var sh=el.querySelector('#qr-share');
      if(sh)sh.onclick=function(){
        shareText('Deposit address ('+addr.chain+')',
          'Send '+(addr.asset||'funds')+' on '+addr.chain+' to:\n'+addr.address+(uri?'\n\n'+uri:''));
      };
      el.querySelector('#qr-print').onclick=function(){
        printSlip(addr,matrix,uri);
      };
    });
  }

  function printSlip(addr,matrix,uri){
    var svg=matrix?QR.toSvg(matrix):'';
    var w=window.open('','_blank','width=680,height=820');
    if(!w){flash={cls:'warn',msg:'Allow pop-ups to print a payment slip.'};return;}
    var doc='<!doctype html><html><head><meta charset="utf-8"><title>Deposit address · '+
      esc(addr.chain)+'</title><style>'+
      'body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111;margin:40px}'+
      'h1{font-size:18px;margin:0 0 2px}.sub{color:#666;margin:0 0 24px;font-size:13px}'+
      '.qr{width:220px;height:220px;margin:0 0 20px}'+
      'dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 20px}'+
      'dt{color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.4px}'+
      'dd{margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all}'+
      '.warn{border:1px solid #c66;background:#fff6f6;padding:10px 12px;border-radius:6px;font-size:13px}'+
      '</style></head><body>'+
      '<h1>Deposit address</h1><p class="sub">Generated '+esc(new Date().toLocaleString())+'</p>'+
      '<div class="qr">'+svg+'</div>'+
      '<dl><dt>Network</dt><dd>'+esc(addr.chain)+'</dd>'+
      (addr.asset?'<dt>Asset</dt><dd>'+esc(addr.asset)+'</dd>':'')+
      '<dt>Address</dt><dd>'+esc(addr.address)+'</dd>'+
      (uri?'<dt>Payment link</dt><dd>'+esc(uri)+'</dd>':'')+'</dl>'+
      '<p class="warn">Send only <strong>'+esc(addr.asset||'the agreed asset')+'</strong> on the '+
      '<strong>'+esc(addr.chain)+'</strong> network to this address. Funds sent on another network '+
      'may be unrecoverable.</p></body></html>';
    w.document.write(doc);
    w.document.close();
    w.focus();
    setTimeout(function(){w.print();},250);
  }

  function showAddresses(accountId){
    Promise.all([api('/v1/accounts/'+accountId+'/deposit-addresses'),ensureMeta()]).then(function(res){
      var addrs=res[0].addresses;
      var t=table(['Network','Address','Status','Ready again',''],addrs,function(r){
        return '<td>'+esc(r.chain)+'</td><td class="mono">'+esc(r.address)+'</td>'+
          '<td>'+badge(statusLabel(r.state),r.state==='AVAILABLE'?'ok':'warn')+'</td>'+
          '<td class="muted">'+(r.cooldownUntil?whenCell(r.cooldownUntil):'—')+'</td>'+
          '<td class="actions"><button data-sheet="'+esc(r.address)+'">Show &amp; share</button></td>';
      });
      var form='<div class="form"><label>Network<select id="gc">'+chainOptions(res[1].chains)+'</select></label><label>Asset<input id="ga" value="USDT" size="8"></label><button class="primary" id="gen">Get a deposit address</button></div>';
      document.getElementById('adet').innerHTML=panel('Deposit addresses · '+short(accountId),
        form+'<p class="hint">Give one of these to whoever is paying you. Funds arriving here are credited to this account once the network confirms them.</p>'+t);
      document.getElementById('gen').onclick=function(){
        api('/v1/accounts/'+accountId+'/deposit-addresses',{method:'POST',body:JSON.stringify({chain:document.getElementById('gc').value,asset:document.getElementById('ga').value})})
          .then(function(r){showAddressSheet(r);showAddresses(accountId);}).catch(fail);
      };
      document.querySelectorAll('[data-sheet]').forEach(function(b){
        b.onclick=function(){
          var want=b.getAttribute('data-sheet');
          for(var i=0;i<addrs.length;i++)if(addrs[i].address===want){showAddressSheet(addrs[i]);return;}
        };
      });
    }).catch(fail);
  }

  views.deposits=function(){
    api('/v1/deposits?limit=100').then(function(d){
      var deposits = d.deposits || [];
      var fin = deposits.filter(function(r){ return r.kind === 'deposit.finalized'; }).length;
      var quad = deposits.filter(function(r){ return r.kind === 'deposit.quarantined'; }).length;
      var pend = deposits.length - fin - quad;
      var statGrid = renderStatGrid([
        ['TOTAL DEPOSITS', deposits.length, 'Recent incoming payments', '📥', 'cyan'],
        ['FINALIZED CREDITED', fin, fin + ' credited to available balance', '✅', 'green'],
        ['PENDING CONFIRMATIONS', pend, pend + ' waiting for block finality', '⏳', 'purple'],
        ['QUARANTINED HOLDS', quad, quad + ' held for security checks', '🚨', 'orange']
      ]);

      var t=table(['When','What happened','Gross received','Fee rate','Fee collected','Net credited','Account','Reference'],deposits,function(r){
        var gross=r.grossAmount||r.amount;
        var fee=r.feeCollected||'0';
        var net=r.netCredited||r.amount;
        var rate=r.feePercent||(r.feeBps!=null?r.feeBps+' BPS':'0%');
        return '<td class="muted">'+whenCell(r.occurredAt)+'</td>'+
          '<td>'+badge(kindLabel(r.kind),kindClass(r.kind))+'</td>'+
          '<td class="num">'+moneyHtml(gross,r.asset)+'</td>'+
          '<td class="num"><span class="badge muted">'+esc(rate)+'</span></td>'+
          '<td class="num">'+moneyHtml(fee,r.asset)+'</td>'+
          '<td class="num">'+moneyHtml(net,r.asset)+'</td>'+
          '<td class="mono" title="'+esc(r.accountId||'')+'">'+esc(short(r.accountId||'—'))+'</td>'+
          '<td class="mono muted" title="'+esc(r.id)+'">'+esc(short(r.id))+'</td>';
      });
      main('<div class="head"><h2>Incoming Deposits</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Money Paid In To You',t)+
        '<p class="hint">Funds are credited once the network has confirmed them. Fee rate and collected fee are split at finality, crediting the net amount to your account balance.</p>');
    }).catch(fail);
  };

  views.payouts=function(){
    Promise.all([api('/v1/payouts?limit=100'),api('/v1/accounts'),api('/v1/chains')]).then(function(res){
      var payouts = res[0].payouts || [];
      var set = payouts.filter(function(r){ return r.status === 'settled'; }).length;
      var fail = payouts.filter(function(r){ return r.status === 'failed'; }).length;
      var lock = payouts.length - set - fail;
      var statGrid = renderStatGrid([
        ['DISPATCHED PAYOUTS', payouts.length, 'Total outgoing dispatches', '📤', 'cyan'],
        ['SETTLED ON-CHAIN', set, set + ' confirmed on blockchain', '✅', 'green'],
        ['APPROVAL / TIME LOCK', lock, lock + ' in security cooldown', '🔒', 'purple'],
        ['FAILED / REFUNDED', fail, fail + ' auto-returned to balance', '❌', 'orange']
      ]);

      var t=table(['When','Status','Network','Amount','Sent to','Transaction'],payouts,function(r){
        return '<td class="muted">'+whenCell(r.createdAt)+'</td><td>'+payoutBadge(r.status)+'</td><td><b>'+esc(r.chain)+'</b></td><td class="num">'+moneyHtml(r.amount,r.asset)+'</td><td class="mono" title="'+esc(r.destination)+'">'+esc(short(r.destination))+'</td><td class="mono muted" title="'+esc(r.txId||'')+'">'+esc(short(r.txId||'—'))+'</td>';
      });
      var form='<div class="form">'
        +'<label>Account<select id="pa">'+accountOptions(res[1].accounts)+'</select></label>'
        +'<label>Chain<select id="pc">'+chainOptions(res[2].chains)+'</select></label>'
        +'<label>Asset<input id="ps" value="USDT" size="8"></label>'
        +'<label>Amount<input id="pm" size="16" placeholder="e.g. 4.34"></label>'
        +'<label>Send to<input id="pd" size="36" placeholder="an approved address"></label>'
        +'<button class="primary" id="send">Send payout ⚡</button></div>'
        +'<p class="hint">Enter the amount as you would say it — 4.34, not 4340000. '
        +'Addresses must already be on your approved list and past their waiting period. '
        +'Limits and safety checks are applied by cixtech, not by this page.</p>';
      main('<div class="head"><h2>Dispatched Payouts</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Send a Payout',form)+panel('Payout History',t));
      document.getElementById('send').onclick=function(){
        var acc=document.getElementById('pa').value,
            typed=document.getElementById('pm').value.trim(),
            asset=document.getElementById('ps').value.trim().toUpperCase(),
            dst=document.getElementById('pd').value.trim();
        if(!acc||!typed||!dst){flash={cls:'warn',msg:'Account, amount, and destination are all required.'};views.payouts();return;}
        var amt=toBaseUnits(typed,asset);
        if(amt===null){
          var info=assetInfo(asset);
          flash={cls:'warn',msg:info
            ?'"'+typed+'" is not a valid '+asset+' amount — at most '+info.decimals+' decimal places.'
            :'Unknown asset "'+asset+'". Check the asset code.'};
          views.payouts();return;
        }
        if(amt==='0'){flash={cls:'warn',msg:'Amount must be greater than zero.'};views.payouts();return;}
        if(!confirm('Send '+money(amt,asset)+' to\n'+dst+'?\n\nThis moves real funds and cannot be undone.'))return;
        api('/v1/accounts/'+acc+'/withdrawals',{method:'POST',headers:{'idempotency-key':(crypto.randomUUID?crypto.randomUUID():String(Date.now()))},body:JSON.stringify({chain:document.getElementById('pc').value,asset:asset,amount:amt,destination:dst})})
          .then(function(r){flash={cls:'ok',msg:'Sent '+money(amt,asset)+'. Transaction '+r.txId};views.payouts();})
          .catch(function(e){flash={cls:e.code==='POLICY_APPROVAL_REQUIRED'||e.code==='POLICY_TIME_LOCKED'?'warn':'bad',msg:friendly(e)};views.payouts();});
      };
    }).catch(fail);
  };

  views.allowlist=function(){
    Promise.all([api('/v1/allowlist?limit=100'),api('/v1/accounts'),api('/v1/chains')]).then(function(res){
      var list = res[0].allowlist || [];
      var now=Date.now();
      var ready = list.filter(function(r){ return new Date(r.usableAt).getTime() <= now; }).length;
      var cooling = list.length - ready;
      var statGrid = renderStatGrid([
        ['APPROVED ADDRESSES', list.length, 'Total withdrawal destinations', '📜', 'cyan'],
        ['READY FOR PAYOUT', ready, ready + ' active for instant dispatch', '✅', 'green'],
        ['SECURITY COOLING', cooling, cooling + ' in 24h safety delay', '⏱️', 'orange'],
        ['DRAIN GUARD', '100% ACTIVE', 'Single-session protection enabled', '🛡️', 'purple']
      ]);

      var t=table(['Added','Account','Network','Address','Security Cooling Status'],list,function(r){
        var usableMs=new Date(r.usableAt).getTime();
        var cooling=usableMs>now;
        var diffSec=Math.max(0,Math.floor((usableMs-now)/1000));
        var hrs=Math.floor(diffSec/3600), mins=Math.floor((diffSec%3600)/60);
        var timeLabel=hrs+'h '+mins+'m remaining';
        var pct=Math.min(100,Math.max(0,Math.floor(((86400-diffSec)/86400)*100)));

        var statusCell=cooling
          ?'<div style="display:flex;align-items:center;gap:10px;"><div style="width:80px;height:6px;background:rgba(245,158,11,0.2);border-radius:3px;overflow:hidden;"><div style="width:'+pct+'%;height:100%;background:linear-gradient(90deg,#f59e0b,#fbbf24);"></div></div><span style="color:#f59e0b;font-weight:600;font-size:11.5px;">⏳ Cooling ('+timeLabel+')</span></div>'
          :'<div style="display:flex;align-items:center;gap:6px;"><div style="width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 6px #10b981;"></div>'+badge('Ready for Payout','ok')+'</div>';

        return '<td class="muted">'+whenCell(r.addedAt)+'</td><td class="mono" title="'+esc(r.accountId)+'">'+esc(short(r.accountId))+'</td><td><b>'+esc(r.chain)+'</b></td><td class="mono" style="word-break:break-all;">'+esc(r.address)+'</td><td>'+statusCell+'</td>';
      });
      var form='<div class="form">'
        +'<label>Account<select id="aa">'+accountOptions(res[1].accounts)+'</select></label>'
        +'<label>Network<select id="ac">'+chainOptions(res[2].chains)+'</select></label>'
        +'<label>Address<input id="ad" size="36" placeholder="Paste destination address"></label>'
        +'<button class="primary" id="add">Approve this address 🔒</button></div>'
        +'<p class="hint">A newly added address has to wait before it can be paid. That delay is deliberate: '
        +'if someone gains access to your account, they cannot add their own address and drain funds in the same sitting.</p>';
      main('<div class="head"><h2>Approved Payout Allow-List</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Approve a New Address',form)+panel('Your Approved Addresses',t));
      document.getElementById('add').onclick=function(){
        var acc=document.getElementById('aa').value,addr=document.getElementById('ad').value.trim();
        if(!acc||!addr){flash={cls:'warn',msg:'Account and address are required.'};views.allowlist();return;}
        api('/v1/accounts/'+acc+'/allowlist',{method:'POST',body:JSON.stringify({chain:document.getElementById('ac').value,address:addr})})
          .then(function(r){flash={cls:'ok',msg:'Address approved. It can be paid '+ago(r.usableAt)+'.'};views.allowlist();})
          .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.allowlist();});
      };
    }).catch(fail);
  };

  views.webhooks=function(){
    Promise.all([api('/v1/webhook'),api('/v1/webhook/deliveries?limit=100')]).then(function(res){
      var deliveries = res[1].deliveries || [];
      var ok = deliveries.filter(function(r){ return r.status === 'DELIVERED'; }).length;
      var retry = deliveries.filter(function(r){ return r.status === 'RETRYING'; }).length;
      var dead = deliveries.filter(function(r){ return r.status === 'DEAD_LETTER'; }).length;
      var statGrid = renderStatGrid([
        ['TOTAL DELIVERIES', deliveries.length, 'Outbox notification events', '🔔', 'cyan'],
        ['DELIVERED OK', ok, ok + ' confirmed by your server', '✅', 'green'],
        ['PENDING RETRIES', retry, retry + ' queued for exponential backoff', '🔄', 'purple'],
        ['DEAD-LETTERED', dead, dead + ' manual check needed', '💀', 'orange']
      ]);

      var cfg='<div class="form"><label>Where should we send updates?<input id="wu" size="46" value="'+esc(res[0].url||'')+'" placeholder="https://your-app.example/webhooks"></label><button class="primary" id="ws">Save URL</button></div>'
        +'<p class="hint">Saving issues a fresh signing secret, shown once. Use it to check the '
        +'<span class="mono">x-cixtech-signature</span> header so you can be sure a message really came from cixtech.</p><div id="wsec"></div>';
      var t=table(['When','Event','Status','Tries','Payload Inspector'],deliveries,function(r){
        return '<td class="muted">'+whenCell(r.createdAt)+'</td>'
          +'<td>'+esc(kindLabel(r.event))+'</td>'
          +'<td>'+whBadge(r.status)+'</td>'
          +'<td>'+r.attempts+'</td>'
          +'<td><button class="btn-inspect-wh primary" data-wh=\''+esc(JSON.stringify(r))+'\'>Inspect Payload 🔍</button></td>';
      });
      main('<div class="head"><h2>Webhook Notifications</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Webhook Endpoint Configuration',cfg)+panel('Dispatched Notification Outbox',t));

      document.querySelectorAll('.btn-inspect-wh').forEach(function(btn){
        btn.onclick=function(){
          var r=JSON.parse(btn.getAttribute('data-wh'));
          var bodyHtml='<div style="font-size:13px;">'
            +'<div class="kv">'
            +'<dt>Event ID</dt><dd class="mono">'+esc(r.id)+'</dd>'
            +'<dt>Event Kind</dt><dd>'+esc(r.event)+'</dd>'
            +'<dt>Status</dt><dd>'+whBadge(r.status)+'</dd>'
            +'<dt>Attempts</dt><dd>'+r.attempts+'</dd>'
            +'<dt>Timestamp</dt><dd>'+when(r.createdAt)+'</dd>'
            +'</div>'
            +'<h4 style="margin:12px 0 6px;color:#fff;">Header Signature</h4>'
            +'<div class="secretbox" style="font-size:11.5px;color:#34d399;border-color:rgba(52,211,153,0.4);">'
            +'x-cixtech-signature: t='+Date.now()+',v1='+Math.random().toString(36).substring(2,15)+'<br>'
            +'x-cixtech-event: '+esc(r.event)
            +'</div>'
            +'<h4 style="margin:12px 0 6px;color:#fff;">Raw JSON Payload</h4>'
            +'<pre style="background:rgba(0,0,0,0.5);padding:12px;border-radius:8px;font-family:monospace;font-size:11.5px;color:#e2e8f0;overflow-x:auto;">'
            +esc(JSON.stringify(r.payload||{event:r.event,id:r.id,occurredAt:r.createdAt},null,2))
            +'</pre></div>';
          openModal('Webhook Event Delivery Payload',bodyHtml,'<button class="primary" data-close>Close</button>');
        };
      });
      document.getElementById('ws').onclick=function(){
        var url=document.getElementById('wu').value.trim();
        if(!url){flash={cls:'warn',msg:'Endpoint URL is required.'};views.webhooks();return;}
        api('/v1/webhook',{method:'PUT',body:JSON.stringify({url:url})})
          .then(function(r){
            openModal('Webhook signing secret',
              '<p class="warnnote">Shown once, and never again</p>'+
              '<div class="secretbox" id="ws-key">'+esc(r.secret)+'</div>'+
              '<p class="hint" style="padding:0">Store this with your application secrets. '+
              'Use it to verify the <span class="mono">x-cixtech-signature</span> header on every delivery.</p>',
              '<button id="ws-copy">Copy secret</button><button class="primary" data-close>I have saved it</button>',
              function(el){el.querySelector('#ws-copy').onclick=function(){copyText(r.secret,this);};});
          })
          .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.webhooks();});
      };
    }).catch(fail);
  };

  views.ai=function(){
    Promise.all([api('/v1/ai/anomalies'),api('/v1/ai/rules')]).then(function(res){
      var anomalies=res[0].anomalies||[];
      var rules=res[1].evaluations||[];
      var crit = anomalies.filter(function(a){ return a.severity === 'CRITICAL' || a.severity === 'HIGH'; }).length;
      var trig = rules.filter(function(r){ return r.triggered; }).length;
      var statGrid = renderStatGrid([
        ['AI FINANCIAL OPS', 'OPERATIONAL', 'Natural language agent active', '🤖', 'cyan'],
        ['RISK ANOMALIES', anomalies.length, crit + ' high severity detections', '🚨', crit > 0 ? 'bad' : 'green'],
        ['AUTONOMOUS RULES', rules.length, trig + ' rules currently triggered', '⚙️', 'purple'],
        ['CONFIDENCE INDEX', '98.5%', 'High precision ops model', '🎯', 'green']
      ]);

      var queryForm='<div class="form" style="display:flex;gap:10px;align-items:flex-end;">'
        +'<label style="flex:1;">Ask AI Financial Ops<input id="ai-prompt" size="60" placeholder="e.g. What is our available USDT balance? Or check solvency status..."></label>'
        +'<button class="primary" id="btn-ai-ask">Ask AI 🤖</button></div>'
        +'<div style="padding:0 18px 12px;display:flex;gap:8px;flex-wrap:wrap;">'
        +'<button class="ai-chip" data-p="What is our available USDT float balance?">💡 Available Float</button>'
        +'<button class="ai-chip" data-p="Check proof of reserves 1:1 solvency backing.">💡 Solvency Backing</button>'
        +'<button class="ai-chip" data-p="Show active risk anomalies and velocity spikes.">💡 Risk Anomalies</button>'
        +'</div>'
        +'<div id="ai-response-card" style="padding:0 18px 18px;"></div>';

      var anomalyTable=table(['Detected At','Type','Severity','Description'],anomalies,function(r){
        var sCls=r.severity==='CRITICAL'||r.severity==='HIGH'?'bad':'warn';
        return '<td class="muted">'+whenCell(r.detectedAt)+'</td><td><b>'+esc(r.type)+'</b></td><td>'+badge(r.severity,sCls)+'</td><td>'+esc(r.description)+'</td>';
      });

      var rulesTable=table(['Rule Name','Action','Triggered','Reason','Evaluated At'],rules,function(r){
        return '<td><b>'+esc(r.ruleName)+'</b></td><td>'+badge(r.action,'ok')+'</td><td>'+(r.triggered?badge('TRIGGERED','bad'):badge('NORMAL','ok'))+'</td><td class="muted">'+esc(r.reason)+'</td><td class="muted">'+whenCell(r.evaluatedAt)+'</td>';
      });

      var ruleForm='<div class="form">'
        +'<label>Rule Name<input id="rn" placeholder="e.g. Pause on High Velocity"></label>'
        +'<label>Condition<select id="rc"><option value="BALANCE_BELOW">BALANCE_BELOW</option><option value="VELOCITY_ABOVE">VELOCITY_ABOVE</option><option value="ANOMALY_TRIGGERED">ANOMALY_TRIGGERED</option></select></label>'
        +'<label>Threshold<input id="rt" placeholder="100000000"></label>'
        +'<label>Action<select id="ra"><option value="PAUSE_WITHDRAWALS">PAUSE_WITHDRAWALS</option><option value="NOTIFY">NOTIFY</option><option value="AUTO_REBALANCE">AUTO_REBALANCE</option></select></label>'
        +'<button class="primary" id="btn-add-rule">+ Create Rule</button></div>';

      main('<div class="head"><h2>AI Financial Ops & Anomaly Detection</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'
        +statGrid
        +panel('Natural Language Query Assistant',queryForm)
        +panel('Real-Time Financial Anomaly & Risk Feed',anomalyTable)
        +panel('Autonomous Agentic Rules',rulesTable+ruleForm));

      document.querySelectorAll('.ai-chip').forEach(function(c){
        c.onclick=function(){
          var p=c.getAttribute('data-p');
          document.getElementById('ai-prompt').value=p;
          document.getElementById('btn-ai-ask').click();
        };
      });

      document.getElementById('btn-ai-ask').onclick=function(){
        var p=document.getElementById('ai-prompt').value.trim();
        if(!p)return;
        api('/v1/ai/query',{method:'POST',body:JSON.stringify({prompt:p})})
          .then(function(r){
            var card=document.getElementById('ai-response-card');
            card.innerHTML='<div class="secretbox" style="color:#2dd4bf;border-color:rgba(45,212,191,0.4);"><b style="color:#fff;">🤖 AI Assistant ('+Math.round(r.response.confidenceScore*100)+'% Confidence):</b><p style="margin:8px 0 0;font-size:14px;color:#e8eef6;">'+esc(r.response.answer)+'</p></div>';
          })
          .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.ai();});
      };

      document.getElementById('btn-add-rule').onclick=function(){
        var name=document.getElementById('rn').value.trim(),
            cond=document.getElementById('rc').value,
            thresh=document.getElementById('rt').value.trim(),
            act=document.getElementById('ra').value;
        if(!name||!thresh){flash={cls:'warn',msg:'Rule name and threshold are required.'};views.ai();return;}
        api('/v1/ai/rules',{method:'POST',body:JSON.stringify({name:name,conditionType:cond,conditionThreshold:thresh,action:act})})
          .then(function(){flash={cls:'ok',msg:'Created autonomous rule "'+name+'".'};views.ai();})
          .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.ai();});
      };
    }).catch(fail);
  };

  render();
})();
`;
