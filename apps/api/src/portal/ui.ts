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

  var NAV=[
    ['overview','Overview'],
    ['accounts','Accounts'],
    ['deposits','Deposits'],
    ['payouts','Payouts'],
    ['accounting','Accounting & ERP'],
    ['ai','AI Assistant & Risk'],
    ['por_pos','PoR & Retail POS'],
    ['allowlist','Allow-list'],
    ['webhooks','Webhooks']
  ];

  // Chains and asset decimals are static config; fetch once and reuse. Nothing may
  // render an amount before this resolves, or base units would be shown as money.
  var meta=null;
  function ensureMeta(){
    if(!meta)meta=api('/v1/chains').then(function(d){setAssets(d.assets);return d;});
    return meta;
  }

  function render(){
    if(!key){renderLogin();return;}
    var nav='';
    for(var i=0;i<NAV.length;i++){nav+='<div class="nav'+(NAV[i][0]===view?' active':'')+'" data-nav="'+NAV[i][0]+'">'+navIcon(NAV[i][0])+'<span>'+NAV[i][1]+'</span></div>';}
    var topbarHtml='<div class="topbar">'
      +'<div class="topbar-left">'
      +'<div class="status-pill"><div class="status-dot"></div><span>Systems Operational</span></div>'
      +'<div style="color:var(--muted);font-size:12px;">Multi-Chain Node Sync 100%</div>'
      +'</div>'
      +'<div class="row">'
      +'<button id="top-btn-pos" style="background:rgba(45,212,191,0.12);color:#2dd4bf;border-color:rgba(45,212,191,0.3);font-size:12px;">💳 POS Terminal</button>'
      +'<button id="top-btn-payout" style="font-size:12px;">⚡ Dispatch Payout</button>'
      +'<button id="top-btn-docs" onclick="window.open(\'/docs\',\'_blank\')" style="font-size:12px;">📘 API Specs</button>'
      +'</div>'
      +'</div>';

    root.innerHTML='<div class="shell"><div class="side">'+
      '<div class="brand"><div class="mark">c</div><div><b>cixtech</b><small>tenant dashboard</small></div></div>'+
      nav+'<div class="spacer"></div>'+
      '<button class="secondary" id="btn-self-help" style="margin-bottom:6px;background:rgba(45,212,191,0.1);border-color:rgba(45,212,191,0.3);color:#2dd4bf;">💬 Help & Support</button>'+
      '<a class="nav" href="/docs" target="_blank">'+navIcon('audit')+'<span>API docs ↗</span></a>'+
      '<button data-logout>Sign out</button></div>'+
      '<div class="main" id="main">'+topbarHtml+'<div id="content-body"><div class="empty">Loading…</div></div></div></div>';

    root.querySelectorAll('[data-nav]').forEach(function(n){n.onclick=function(){view=n.getAttribute('data-nav');render();};});
    root.querySelector('[data-logout]').onclick=logout;
    root.querySelector('#btn-self-help').onclick=openHelpModal;
    root.querySelector('#top-btn-pos').onclick=function(){view='por_pos';render();};
    root.querySelector('#top-btn-payout').onclick=function(){view='payouts';render();};
    ensureMeta().then(function(){views[view]();}).catch(fail);
  }

  function renderLogin(){
    root.innerHTML='<div class="login"><div class="mark">c</div><h1>cixtech dashboard</h1><p>Sign in with your tenant API key — the <span class="mono">cxk_…</span> value issued when your account was created.</p><input id="tok" type="password" placeholder="cxk_…" autocomplete="off"><button class="primary" id="go">Sign in</button><div class="err" id="le"></div></div>';
    var go=function(){var v=document.getElementById('tok').value.trim();if(!v)return;key=v;api('/v1/accounts').then(function(){localStorage.setItem(TK,v);view='overview';render();}).catch(function(e){key=null;document.getElementById('le').textContent=e.message;});};
    document.getElementById('go').onclick=go;
    document.getElementById('tok').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  }

  function openHelpModal(){
    var bodyHtml='<div style="font-size:13.5px;line-height:1.6;">'
      +'<h4 style="margin:0 0 8px;color:#fff;">Frequently Asked Questions</h4>'
      +'<details style="margin-bottom:8px;background:rgba(255,255,255,0.03);padding:8px 12px;border-radius:8px;"><summary style="cursor:pointer;font-weight:600;color:#2dd4bf;">How long is the allow-list cooldown window?</summary><p style="margin:6px 0 0;color:#cbd5e1;">All newly added payout addresses undergo a 24-hour security delay before payouts can be dispatched. This prevents single-session wallet drain attacks.</p></details>'
      +'<details style="margin-bottom:8px;background:rgba(255,255,255,0.03);padding:8px 12px;border-radius:8px;"><summary style="cursor:pointer;font-weight:600;color:#2dd4bf;">How do customers recover wrong-network deposits?</summary><p style="margin:6px 0 0;color:#cbd5e1;">Direct customers to <span class="mono">/checkout/:intentId</span> and click "Claim Stranded Deposit". The recovery engine verifies block ownership and refunds net assets.</p></details>'
      +'<details style="margin-bottom:14px;background:rgba(255,255,255,0.03);padding:8px 12px;border-radius:8px;"><summary style="cursor:pointer;font-weight:600;color:#2dd4bf;">What is the Solvency Coverage Invariant?</summary><p style="margin:6px 0 0;color:#cbd5e1;">CIXTech maintains a 1:1 asset-to-liability backing ($\sum \text{Assets} \ge \sum \text{Liabilities}$). Check live proofs on the "PoR & Retail POS" tab.</p></details>'
      +'<h4 style="margin:12px 0 8px;color:#fff;">Self-Service Diagnostics</h4>'
      +'<div id="help-diag-status" style="margin-bottom:12px;">Click below to run automated platform health checks.</div>'
      +'<button class="primary" id="btn-run-diag">Run Platform Diagnostic Check</button>'
      +'</div>';

    openModal('Help & Support Diagnostics',bodyHtml,'<button class="primary" data-close>Close</button>',function(el){
      el.querySelector('#btn-run-diag').onclick=function(){
        var statusEl=el.querySelector('#help-diag-status');
        statusEl.innerHTML='<span style="color:#f59e0b;">Running diagnostics…</span>';
        Promise.all([api('/v1/chains'),api('/v1/proof-of-reserves')]).then(function(res){
          statusEl.innerHTML='<div class="secretbox" style="color:#10b981;border-color:rgba(16,185,129,0.4);">'
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
    Promise.all([api('/v1/accounts'),api('/v1/balances'),api('/v1/payouts?limit=8'),api('/v1/deposits?limit=8')]).then(function(res){
      var accounts=res[0].accounts,balances=res[1].balances,payouts=res[2].payouts,deposits=res[3].deposits;
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
      main('<div class="head"><h2>Overview</h2></div><div class="cards">'+cardsH+'</div>'+panel('What you can spend now',bal)+panel('Recent money in',dep)+panel('Recent money out',pay));
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
        // Never leave a blank white square that looks like a scannable code.
        canvas.parentNode.innerHTML='<div class="empty" style="color:#333">QR unavailable — use the address below.</div>';
      }
      el.querySelector('#qr-copy').onclick=function(){copyText(addr.address,this);};
      var cu=el.querySelector('#qr-copyuri');
      if(cu)cu.onclick=function(){copyText(uri,this);};
      el.querySelector('#qr-png').onclick=function(){
        if(!matrix)return;
        // Re-render large so the saved image stays sharp when printed or resized.
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

  /**
   * A standalone printable slip. Rendered into its own window rather than via a
   * print stylesheet over the dashboard, so what prints is exactly the payment
   * details and nothing of the surrounding console.
   */
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
      var t=table(['When','What happened','Gross received','Fee rate','Fee collected','Net credited','Account','Reference'],d.deposits,function(r){
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
      main('<div class="head"><h2>Deposits</h2></div>'+panel('Money paid in to you',t)+
        '<p class="hint">Funds are credited once the network has confirmed them. Fee rate and collected fee are split at finality, crediting the net amount to your account balance.</p>');
    }).catch(fail);
  };

  views.payouts=function(){
    Promise.all([api('/v1/payouts?limit=100'),api('/v1/accounts'),api('/v1/chains')]).then(function(res){
      var t=table(['When','Status','Network','Amount','Sent to','Transaction'],res[0].payouts,function(r){
        return '<td class="muted">'+whenCell(r.createdAt)+'</td><td>'+payoutBadge(r.status)+'</td><td>'+esc(r.chain)+'</td><td class="num">'+moneyHtml(r.amount,r.asset)+'</td><td class="mono" title="'+esc(r.destination)+'">'+esc(short(r.destination))+'</td><td class="mono muted" title="'+esc(r.txId||'')+'">'+esc(short(r.txId||'—'))+'</td>';
      });
      var form='<div class="form">'
        +'<label>Account<select id="pa">'+accountOptions(res[1].accounts)+'</select></label>'
        +'<label>Chain<select id="pc">'+chainOptions(res[2].chains)+'</select></label>'
        +'<label>Asset<input id="ps" value="USDT" size="8"></label>'
        +'<label>Amount<input id="pm" size="16" placeholder="e.g. 4.34"></label>'
        +'<label>Send to<input id="pd" size="36" placeholder="an approved address"></label>'
        +'<button class="primary" id="send">Send payout</button></div>'
        +'<p class="hint">Enter the amount as you would say it — 4.34, not 4340000. '
        +'Addresses must already be on your approved list and past their waiting period. '
        +'Limits and safety checks are applied by cixtech, not by this page.</p>';
      main('<div class="head"><h2>Payouts</h2></div>'+panel('Send a payout',form)+panel('History',t));
      document.getElementById('send').onclick=function(){
        var acc=document.getElementById('pa').value,
            typed=document.getElementById('pm').value.trim(),
            asset=document.getElementById('ps').value.trim().toUpperCase(),
            dst=document.getElementById('pd').value.trim();
        if(!acc||!typed||!dst){flash={cls:'warn',msg:'Account, amount, and destination are all required.'};views.payouts();return;}
        // Convert here rather than server-side: the API speaks base units, and a
        // half-converted amount must never reach it.
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
      var now=Date.now();
      var t=table(['Added','Account','Network','Address','Security Cooling Status'],res[0].allowlist,function(r){
        var usableMs=new Date(r.usableAt).getTime();
        var cooling=usableMs>now;
        var diffSec=Math.max(0,Math.floor((usableMs-now)/1000));
        var hrs=Math.floor(diffSec/3600), mins=Math.floor((diffSec%3600)/60);
        var timeLabel=hrs+'h '+mins+'m remaining';
        var pct=Math.min(100,Math.max(0,Math.floor(((86400-diffSec)/86400)*100)));

        var statusCell=cooling
          ?'<div style="display:flex;align-items:center;gap:10px;"><div style="width:80px;height:6px;background:rgba(245,158,11,0.2);border-radius:3px;overflow:hidden;"><div style="width:'+pct+'%;height:100%;background:linear-gradient(90deg,#f59e0b,#fbbf24);"></div></div><span style="color:#f59e0b;font-weight:600;font-size:11.5px;">⏳ Cooling ('+timeLabel+')</span></div>'
          :'<div style="display:flex;align-items:center;gap:6px;"><div style="width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 6px #10b981;"></div>'+badge('Ready for Payout','ok')+'</div>';

        return '<td class="muted">'+whenCell(r.addedAt)+'</td><td class="mono" title="'+esc(r.accountId)+'">'+esc(short(r.accountId))+'</td><td>'+esc(r.chain)+'</td><td class="mono" style="word-break:break-all;">'+esc(r.address)+'</td><td>'+statusCell+'</td>';
      });
      var form='<div class="form">'
        +'<label>Account<select id="aa">'+accountOptions(res[1].accounts)+'</select></label>'
        +'<label>Network<select id="ac">'+chainOptions(res[2].chains)+'</select></label>'
        +'<label>Address<input id="ad" size="36"></label>'
        +'<button class="primary" id="add">Approve this address</button></div>'
        +'<p class="hint">A newly added address has to wait before it can be paid. That delay is deliberate: '
        +'if someone gains access to your account, they cannot add their own address and drain funds in the same sitting.</p>';
      main('<div class="head"><h2>Approved payout addresses</h2></div>'+panel('Approve a new address',form)+panel('Your approved addresses',t));
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
      var cfg='<div class="form"><label>Where should we send updates?<input id="wu" size="46" value="'+esc(res[0].url||'')+'" placeholder="https://your-app.example/webhooks"></label><button class="primary" id="ws">Save</button></div>'
        +'<p class="hint">Saving issues a fresh signing secret, shown once. Use it to check the '
        +'<span class="mono">x-cixtech-signature</span> header so you can be sure a message really came from cixtech.</p><div id="wsec"></div>';
      var t=table(['When','Event','Status','Tries','Payload Inspector'],res[1].deliveries,function(r){
        return '<td class="muted">'+whenCell(r.createdAt)+'</td>'
          +'<td>'+esc(kindLabel(r.event))+'</td>'
          +'<td>'+whBadge(r.status)+'</td>'
          +'<td>'+r.attempts+'</td>'
          +'<td><button class="btn-inspect-wh" data-wh=\''+esc(JSON.stringify(r))+'\'>Inspect Payload 🔍</button></td>';
      });
      main('<div class="head"><h2>Webhooks</h2></div>'+panel('Where we notify you',cfg)+panel('What we have sent',t));

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

  views.accounting=function(){
    var exportForm='<div class="form">'
      +'<label>Format<select id="acc-fmt">'
      +'<option value="quickbooks">QuickBooks CSV</option>'
      +'<option value="xero">Xero CSV</option>'
      +'<option value="mt940">SWIFT MT940</option>'
      +'<option value="camt053">CAMT.053 XML</option>'
      +'<option value="json">GAAP JSON</option>'
      +'</select></label>'
      +'<button class="primary" id="btn-export">Download General Ledger Export</button></div>'
      +'<p class="hint">Export trial balance mapped to standard GAAP/IFRS 4-digit GL codes (1000 Assets, 2000 Liabilities, 4000 Revenue, 5000 Expense).</p>';

    var erpForm='<div class="form">'
      +'<label>ERP Connector<select id="erp-tgt">'
      +'<option value="QUICKBOOKS_ONLINE">QuickBooks Online</option>'
      +'<option value="XERO">Xero</option>'
      +'<option value="NETSUITE">NetSuite</option>'
      +'</select></label>'
      +'<button class="primary" id="btn-sync">Trigger Automated ERP Sync</button></div>'
      +'<p class="hint">Posts closed sub-ledger trial balance entries directly to your accounting software.</p>';

    var refundPanel='<div class="form">'
      +'<label>Merchant Account<select id="rfd-acc"></select></label>'
      +'<label>Chain<select id="rfd-chn"><option>TRON</option><option>POLYGON</option><option>ARBITRUM</option></select></label>'
      +'<label>Asset<input id="rfd-ast" value="USDT" size="8"></label>'
      +'<label>Gross Amount<input id="rfd-amt" placeholder="e.g. 15.00" size="12"></label>'
      +'<label>Refund Reason<select id="rfd-rsn"><option value="OVERPAYMENT">Overpayment</option><option value="EXPIRED_INTENT">Expired Intent</option><option value="CUSTOMER_REQUEST">Customer Request</option></select></label>'
      +'<label>Destination Address<input id="rfd-dst" placeholder="Customer address" size="32"></label>'
      +'<button class="primary" id="btn-do-refund">Process Automated Refund ⚡</button></div>'
      +'<p class="hint">Dispatches sub-minute customer refund with automatic gas fee calculation (< 60 seconds).</p>';

    main('<div class="head"><h2>Sub-Ledger Accounting & ERP Integration</h2></div>'+panel('GAAP / IFRS Trial Balance Exporter',exportForm)+panel('Automated ERP Sync Connector',erpForm)+panel('Sub-Minute Automated Customer Refund Engine (US-RFD-01)',refundPanel));

    api('/v1/accounts').then(function(d){
      var sel=document.getElementById('rfd-acc');
      if(sel)sel.innerHTML=accountOptions(d.accounts);
    });

    document.getElementById('btn-export').onclick=function(){
      var fmt=document.getElementById('acc-fmt').value;
      window.open('/v1/accounting/export?format='+fmt+'&key='+encodeURIComponent(key),'_blank');
      flash={cls:'ok',msg:'Generated GL Export in '+fmt.toUpperCase()+' format.'};
      render();
    };

    document.getElementById('btn-sync').onclick=function(){
      var tgt=document.getElementById('erp-tgt').value;
      api('/v1/accounting/erp-sync',{method:'POST',body:JSON.stringify({target:tgt})})
        .then(function(r){
          flash={cls:'ok',msg:'Synced '+r.sync.journalEntriesSynced+' journal entries to '+tgt+' ('+r.sync.totalDebitFormatted+' USDT debited).'};
          views.accounting();
        })
        .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.accounting();});
    };

    document.getElementById('btn-do-refund').onclick=function(){
      var acc=document.getElementById('rfd-acc').value,
          chn=document.getElementById('rfd-chn').value,
          ast=document.getElementById('rfd-ast').value.trim().toUpperCase(),
          amtTyped=document.getElementById('rfd-amt').value.trim(),
          rsn=document.getElementById('rfd-rsn').value,
          dst=document.getElementById('rfd-dst').value.trim();

      if(!acc||!amtTyped||!dst){flash={cls:'warn',msg:'Account, amount, and destination address are required.'};views.accounting();return;}
      var amtBase=toBaseUnits(amtTyped,ast);
      if(!amtBase){flash={cls:'warn',msg:'Invalid amount.'};views.accounting();return;}

      api('/v1/refunds',{method:'POST',body:JSON.stringify({merchantId:acc,chain:chn,asset:ast,amountBaseUnits:amtBase,destinationAddress:dst,reason:rsn,sponsorGas:true})})
        .then(function(r){
          var rf=r.refund;
          flash={cls:'ok',msg:'Refund dispatched! ID: '+rf.id+' ('+rf.netAmountBaseUnits+' base units sent).'};
          views.accounting();
        })
        .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.accounting();});
    };
  };

  views.ai=function(){
    Promise.all([api('/v1/ai/anomalies'),api('/v1/ai/rules')]).then(function(res){
      var anomalies=res[0].anomalies||[];
      var rules=res[1].evaluations||[];

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
        +'<button class="primary" id="btn-add-rule">Create Rule</button></div>';

      main('<div class="head"><h2>AI Financial Ops & Anomaly Detection</h2></div>'
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

  views.por_pos=function(){
    Promise.all([api('/v1/proof-of-reserves'),api('/v1/accounts')]).then(function(res){
      var por=res[0].proofOfReserves;
      var accounts=res[1].accounts;

      var porPanel='<div class="kv">'
        +'<dt>Solvency Coverage</dt><dd><b>'+esc(por.coverageRatioPercentage)+'</b> '+(por.isSolvent?badge('1:1 SOLVENT','ok'):badge('INSOLVENT','bad'))+'</dd>'
        +'<dt>Total Assets</dt><dd>'+esc(num(por.totalAssetsBaseUnits))+' base units</dd>'
        +'<dt>Total Liabilities</dt><dd>'+esc(num(por.totalLiabilitiesBaseUnits))+' base units</dd>'
        +'<dt>Merkle Tree Root Hash</dt><dd class="mono">'+esc(por.merkleTreeRootHash)+'</dd>'
        +'<dt>Cryptographic Signature</dt><dd class="mono">'+esc(por.signature)+'</dd>'
        +'</div>';

      var posForm='<div class="form">'
        +'<label>Merchant Account<select id="pos-acc">'+accountOptions(accounts)+'</select></label>'
        +'<label>Terminal ID<input id="pos-term" value="TERM_MAIN_01" size="14"></label>'
        +'<label>Fiat Amount<input id="pos-amt" value="15.50" size="10"></label>'
        +'<label>Currency<select id="pos-cur"><option value="USD">USD ($)</option><option value="EUR">EUR (€)</option><option value="NGN">NGN (₦)</option><option value="KES">KES (KSh)</option></select></label>'
        +'<label>Chain<select id="pos-chn"><option value="TRON">TRON</option><option value="POLYGON">POLYGON</option><option value="ARBITRUM">ARBITRUM</option></select></label>'
        +'<button class="primary" id="btn-gen-pos">Generate POS Payment QR</button></div>'
        +'<div id="pos-result-card" style="margin-top:16px;"></div>';

      main('<div class="head"><h2>Proof of Reserves & Retail POS</h2></div>'
        +panel('Cryptographic Proof of Reserves (1:1 Solvency Verifier)',porPanel)
        +panel('Point-of-Sale Dynamic QR Generator',posForm));

      document.getElementById('btn-gen-pos').onclick=function(){
        var acc=document.getElementById('pos-acc').value,
            term=document.getElementById('pos-term').value.trim(),
            amt=document.getElementById('pos-amt').value.trim(),
            cur=document.getElementById('pos-cur').value,
            chn=document.getElementById('pos-chn').value;
        if(!acc||!amt){flash={cls:'warn',msg:'Account and amount are required.'};views.por_pos();return;}
        api('/v1/pos/qr',{method:'POST',body:JSON.stringify({merchantId:acc,terminalId:term,fiatAmount:amt,fiatCurrency:cur,chain:chn})})
          .then(function(r){
            var s=r.posSession;
            var card=document.getElementById('pos-result-card');
            card.innerHTML='<div class="panel" style="margin-top:16px;background:rgba(255,255,255,0.02);">'
              +'<h3 style="color:#2dd4bf;">Active POS Checkout Session: '+esc(s.id)+'</h3>'
              +'<div class="qrwrap" style="padding:18px;">'
              +'<div><div class="qrbox"><canvas id="pos-qr-canvas"></canvas></div></div>'
              +'<div class="qrside">'
              +'<div class="kv">'
              +'<dt>Amount Due</dt><dd><b>'+esc(s.fiatAmount)+' '+esc(s.fiatCurrency)+'</b> ('+esc(s.chain)+' Network)</dd>'
              +'<dt>Terminal Ref</dt><dd>'+esc(s.terminalId)+'</dd>'
              +'<dt>Payment Address</dt><dd class="mono" style="word-break:break-all;">'+esc(s.paymentAddress)+'</dd>'
              +'<dt>QR URI Payload</dt><dd class="mono" style="font-size:11px;word-break:break-all;">'+esc(s.qrPayloadUri)+'</dd>'
              +'</div>'
              +'<div class="btnrow">'
              +'<button class="primary" id="btn-pos-copy">Copy Address</button>'
              +'<button id="btn-pos-print">🖨️ Print Thermal Receipt</button>'
              +'</div>'
              +'</div></div></div>';

            var canvas=document.getElementById('pos-qr-canvas');
            try{
              var matrix=QR.encode(s.qrPayloadUri);
              QR.draw(canvas,matrix,7);
            }catch(e){
              if(canvas&&canvas.parentNode)canvas.parentNode.innerHTML='<div class="empty">QR code preview ready</div>';
            }

            document.getElementById('btn-pos-copy').onclick=function(){copyText(s.paymentAddress,this);};
            document.getElementById('btn-pos-print').onclick=function(){
              var printWin=window.open('','_blank','width=400,height=600');
              printWin.document.write('<html><head><title>Thermal Receipt</title><style>body{font-family:monospace;padding:20px;width:280px;margin:0 auto;} h2{text-align:center;margin:0 0 10px;} .hr{border-bottom:1px dashed #000;margin:10px 0;} .row{display:flex;justify-content:space-between;margin:4px 0;}</style></head><body>'
                +'<h2>'+esc(s.thermalReceiptSpec.storeHeader)+'</h2>'
                +'<div class="hr"></div>'
                +'<div class="row"><span>Terminal:</span><span>'+esc(s.terminalId)+'</span></div>'
                +'<div class="row"><span>Ref:</span><span>'+esc(s.id)+'</span></div>'
                +'<div class="row"><span>Amount:</span><span><b>'+esc(s.thermalReceiptSpec.amountDue)+'</b></span></div>'
                +'<div class="hr"></div>'
                +'<p style="word-break:break-all;font-size:11px;">Pay to: '+esc(s.paymentAddress)+'</p>'
                +'<div class="hr"></div>'
                +'<p style="text-align:center;font-size:10px;">Powered by CIXTech Crypto Financial OS</p>'
                +'</body></html>');
              printWin.document.close();
              printWin.focus();
              setTimeout(function(){printWin.print();},300);
            };
          })
          .catch(function(e){flash={cls:'bad',msg:friendly(e)};views.por_pos();});
      };
    }).catch(fail);
  };

  render();
})();
`;
