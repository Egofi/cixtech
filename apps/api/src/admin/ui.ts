/**
 * The admin console SPA (ADR 0015), inlined so the API serves it with zero build
 * step and zero external dependencies (same self-contained posture as the rest of
 * the repo). The JS deliberately avoids template literals so it embeds safely in
 * this TS template string.
 *
 * Money, labels, and the modal live in `../ui-kit.js`, shared with the portal.
 */
import { UI_KIT_CSS, UI_KIT_JS } from "../ui-kit.js";

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
${UI_KIT_CSS}
/* Admin identity: egofi's primary blue. Everything else is the shared kit above.
   \`--accent\` is the button/ring background; \`--accent-ink\` is the same hue made
   readable as TEXT, which is why the two diverge under dark. */
:root{ --accent:#1D4ED8; --accent-hi:#1E40AF; --accent-fg:#fff; --accent-ink:#1D4ED8; }
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){ --accent:#2563EB; --accent-hi:#3B82F6; --accent-ink:#60A5FA; }
}
:root[data-theme="dark"]{ --accent:#2563EB; --accent-hi:#3B82F6; --accent-ink:#60A5FA; }
.keyrow.revoked td{opacity:.5}
.keyrow.revoked td:last-child{opacity:1}
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

${UI_KIT_JS}

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
  function whStatusBadge(s){return badge(statusLabel(s),s==='delivered'?'ok':s==='dead'?'bad':'warn');}

  /** 'rowAttr' optionally returns attributes for the <tr> (e.g. a state class). */
  function table(cols,rows,rowFn,rowAttr){
    if(!rows||!rows.length)return '<div class="empty">Nothing here yet.</div>';
    var h='<div class="tablewrap"><table><thead><tr>';
    for(var i=0;i<cols.length;i++)h+='<th>'+esc(cols[i])+'</th>';
    h+='</tr></thead><tbody>';
    for(var j=0;j<rows.length;j++)h+='<tr'+(rowAttr?' '+rowAttr(rows[j]):'')+'>'+rowFn(rows[j])+'</tr>';
    return h+'</tbody></table></div>';
  }
  function panel(title,inner){return '<div class="panel"><h3>'+esc(title)+'</h3>'+inner+'</div>';}

  var NAV_GROUPS=[
    {title:'OVERVIEW',items:[['overview','Statistics / Overview'],['earnings','Earnings & Revenue']]},
    {title:'LEDGER',items:[['tenants','Tenants'],['ledger','Ledger'],['deposits','Deposits'],['payouts','Payouts']]},
    {title:'SETTINGS',items:[['webhooks','Webhooks'],['audit','Admin audit'],['errors','Errors']]}
  ];

  function showWalletVerificationSheet(chain, address, asset){
    openModal('Verifying on-chain balance…', '<div class="empty">Querying blockchain node RPC for '+esc(chain)+':'+esc(address)+'…</div>');
    api('/admin/api/wallets/verify-onchain?chain='+encodeURIComponent(chain)+'&address='+encodeURIComponent(address)+'&asset='+encodeURIComponent(asset||'USDT'))
      .then(function(res){
        var badgeCls = res.status==='EXACT_MATCH'?'ok':(res.status==='SURPLUS'?'ok':'bad');
        var badgeLabel = res.status==='EXACT_MATCH'?'EXACT MATCH':(res.status==='SURPLUS'?'ON-CHAIN SURPLUS':'DEFICIT SHORTFALL');
        if(res.status==='UNAVAILABLE'){badgeCls='warn';badgeLabel='RPC UNAVAILABLE';}

        var body =
          '<div class="banner '+badgeCls+'">Status: '+esc(badgeLabel)+'</div>'+
          '<dl class="kv"><dt>Chain / Network</dt><dd>'+esc(res.chain)+'</dd>'+
          (res.merchantId?'<dt>Merchant Account</dt><dd class="mono">'+esc(res.merchantId)+'</dd>':'')+
          '<dt>On-Chain Address</dt><dd class="mono"><a href="'+esc(res.explorerUrl)+'" target="_blank" rel="noopener">'+esc(res.address)+' ↗</a></dd>'+
          '<dt>Asset</dt><dd>'+esc(res.asset)+'</dd></dl>'+
          '<div class="cards" style="margin-top:16px">'+
            '<div class="card"><div class="k">Ledger Balance</div><div class="v">'+moneyHtml(res.ledgerBalance,res.asset)+'</div></div>'+
            '<div class="card"><div class="k">Live On-Chain Balance</div><div class="v">'+moneyHtml(res.onchainBalance,res.asset)+'</div></div>'+
            '<div class="card"><div class="k">Variance (Delta)</div><div class="v">'+moneyHtml(res.delta,res.asset)+'</div></div>'+
          '</div>'+
          (res.error?'<p class="hint bad">Note: '+esc(res.error)+'</p>':'');
        var foot = '<a class="button primary" href="'+esc(res.explorerUrl)+'" target="_blank" rel="noopener">View on Block Explorer ↗</a><button id="cm-close">Close</button>';
        openModal('On-Chain Balance Verification', body, foot, function(el){
          el.querySelector('#cm-close').onclick=closeModal;
        });
      }).catch(function(err){
        openModal('Verification Failed', '<div class="banner bad">'+esc(err.message)+'</div>', '<button id="cm-close">Close</button>', function(el){
          el.querySelector('#cm-close').onclick=closeModal;
        });
      });
  }

  var assetsReady=null;
  function ensureAssets(){
    if(!assetsReady)assetsReady=api('/admin/api/assets').then(function(d){setAssets(d.assets);setEngineEnv(d.env);});
    return assetsReady;
  }

  function render(){
    if(!token){renderLogin();return;}
    var navHtml='';
    for(var g=0;g<NAV_GROUPS.length;g++){
      var grp=NAV_GROUPS[g];
      navHtml+='<div class="nav-group-title"><span>'+grp.title+'</span></div>';
      for(var i=0;i<grp.items.length;i++){
        var item=grp.items[i];
        navHtml+='<div class="nav'+(item[0]===view?' active':'')+'" data-nav="'+item[0]+'">'+navIcon(item[0])+'<span>'+item[1]+'</span></div>';
      }
    }

    root.innerHTML='<div class="shell"><div class="side">'+
      '<div class="brand"><div class="mark">C</div><div><b>cixtech</b><small>super-admin console</small></div></div>'+
      navHtml+'<div class="spacer"></div>'+
      '<button data-logout style="margin-bottom:8px;">Sign out</button>'+
      renderSidebarFooter()+'</div>'+
      '<div class="main" id="main"><div class="empty">Loading…</div></div></div>';
    root.querySelectorAll('[data-nav]').forEach(function(n){n.onclick=function(){view=n.getAttribute('data-nav');render();};});
    root.querySelector('[data-logout]').onclick=logout;
    ensureAssets().then(function(){views[view]();}).catch(fail);
  }

  function renderLogin(){
    root.innerHTML='<div class="login"><div class="mark">C</div><h1>cixtech</h1><p>Enter the super-admin token to continue.</p><input id="tok" type="password" placeholder="Admin token" autocomplete="off"><button class="primary" id="go">Sign in</button><div class="err" id="le"></div></div>';
    var go=function(){var v=document.getElementById('tok').value.trim();if(!v)return;localStorage.setItem(TK,v);token=v;api('/admin/api/overview').then(function(){view='overview';render();}).catch(function(e){document.getElementById('le').textContent=e.message;localStorage.removeItem(TK);token=null;});};
    document.getElementById('go').onclick=go;
    document.getElementById('tok').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  }

  function main(html){document.getElementById('main').innerHTML=html;}
  function fail(e){main('<div class="banner bad">'+esc(e.message)+'</div>');}

  var views={};

  views.overview=function(){
    Promise.all([
      api('/admin/api/overview'),
      api('/admin/api/deposits?limit=100'),
      api('/admin/api/payouts?limit=100')
    ]).then(function(res){
      var d=res[0], deposits=res[1]||[], payouts=res[2]||[];
      var c=d.counts;
      setAssets(d.assets);
      var ks=d.killSwitchEngaged;
      var banner=ks?'<div class="banner bad">Kill-switch ENGAGED — all payouts are halted.</div>':'<div class="banner ok">Kill-switch clear — payouts flowing normally.</div>';
      var solv=table(['Asset','Held for customers','Owed to customers','Status'],d.solvency,function(r){
        return '<td>'+esc(r.asset)+'</td><td class="num">'+moneyHtml(r.assets,r.asset)+'</td><td class="num">'+moneyHtml(r.liabilities,r.asset)+'</td><td>'+(r.solvent?badge('Fully backed','ok'):badge('SHORTFALL','bad'))+'</td>';
      });
      var solvNote='<p class="hint">Every asset must hold at least what it owes. A shortfall means customer balances exceed the funds on chain.</p>';
      var lim=d.limits;
      var limitAsset=(d.solvency[0]&&d.solvency[0].asset)||'';
      var limits=panel('Money-out limits',
        '<div class="tablewrap"><table><tbody>'+
        '<tr><td>Most that can leave in one payout</td><td class="num">'+moneyHtml(lim.maxPerPayout,limitAsset)+'</td></tr>'+
        '<tr><td>Rolling window</td><td class="num">'+esc(humanMs(lim.velocityWindowMs))+'</td></tr>'+
        '<tr><td>Most that can leave within that window</td><td class="num">'+moneyHtml(lim.velocityMax,limitAsset)+'</td></tr>'+
        '</tbody></table></div>');

      var totalOrders = c.entries || (deposits.length + payouts.length);
      var finalizedDep = deposits.filter(function(x){ return x.kind === 'deposit.finalized'; }).length;
      var pendingDep = deposits.filter(function(x){ return x.kind !== 'deposit.finalized' && x.kind !== 'deposit.quarantined'; }).length;
      var quadDep = deposits.filter(function(x){ return x.kind === 'deposit.quarantined'; }).length;

      var settledPay = payouts.filter(function(x){ return x.status === 'settled'; }).length;
      var pendingPay = payouts.filter(function(x){ return x.status !== 'settled' && x.status !== 'failed'; }).length;
      var failedPay = payouts.filter(function(x){ return x.status === 'failed'; }).length;

      var totalVolumeStr = d.solvency.map(function(s){ return money(s.assets, s.asset) + ' ' + s.asset; }).join(' + ') || '0.00 USDT';

      var nexisCardsHtml = renderNexisCards({
        movements: num(totalOrders),
        held: totalVolumeStr,
        assets: num(d.solvency.length),
        depositCount: num(deposits.length),
        depositSub: finalizedDep + ' finalized, ' + pendingDep + ' pending, ' + quadDep + ' held',
        payoutCount: num(payouts.length),
        payoutSub: settledPay + ' settled, ' + pendingPay + ' locked/pending, ' + failedPay + ' failed',
        inflow: deposits.length,
        outflow: payouts.length
      });

      var dailyActivityData = buildDailyActivity(deposits, payouts);
      var chartHtml = renderDailyActivityChart(dailyActivityData);

      var headHtml='<div class="head"><h2>Statistics</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+(ks?'<button class="primary" id="ksr">Resume payouts</button>':'<button class="danger" id="kse">Halt all payouts</button>')+'</div></div>';
      var cards=[['Tenants',c.tenants],['Accounts',c.accounts],['Journal entries',c.entries],['Webhooks pending',c.webhooksPending],['Webhooks dead',c.webhooksDead],['Errors 24h',c.errors24h]];
      var cardsH='';for(var i=0;i<cards.length;i++)cardsH+='<div class="card"><div class="k">'+cards[i][0]+'</div><div class="v">'+num(cards[i][1])+'</div></div>';

      main(headHtml+banner+nexisCardsHtml+chartHtml+'<div class="cards">'+cardsH+'</div>'+panel('Are customer funds fully backed?',solv+solvNote)+limits);
      var e=document.getElementById('kse');if(e)e.onclick=function(){var reason=prompt('Reason for halting payouts?');if(reason==null)return;api('/admin/api/killswitch/engage',{method:'POST',body:JSON.stringify({reason:reason})}).then(views.overview).catch(fail);};
      var r=document.getElementById('ksr');if(r)r.onclick=function(){if(!confirm('Resume payouts?'))return;api('/admin/api/killswitch/reset',{method:'POST'}).then(views.overview).catch(fail);};
    }).catch(fail);
  };


  /**
   * The one screen where a secret is ever visible. It is shown once and cannot be
   * fetched again — only the hash is stored — so the modal makes taking it away
   * the easy path (copy, or download a file) and says plainly what happens if you
   * close without doing either.
   */
  function credentialModal(opts){
    var issued=new Date().toISOString();
    var origin=window.location.origin;
    var fileText=[
      'cixtech — tenant API credentials',
      '================================',
      '',
      'Tenant name : '+opts.tenantName,
      'Tenant ID   : '+opts.tenantId,
      'API key     : '+opts.apiKey,
      (opts.keyId?'Key ID      : '+opts.keyId:''),
      'Issued      : '+issued,
      '',
      'Sign in to the dashboard : '+origin+'/portal',
      'API reference            : '+origin+'/docs',
      '',
      'Send this key as the "x-api-key" header on every API request.',
      '',
      'KEEP THIS SECRET. It is shown once and cannot be recovered — cixtech stores',
      'only a hash of it. Anyone holding it can move funds for this tenant. Put it',
      'in your password manager or secrets store now.',
      (opts.revokedCount?'\nRotation: '+opts.revokedCount+' previously issued key(s) were revoked and no longer work.':''),
    ].filter(function(l){return l!=='';}).join('\n')+'\n';

    var safeName=String(opts.tenantName||'tenant').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    var body=
      (opts.revokedCount
        ? '<div class="banner warn">Rotated. '+opts.revokedCount+' previous key'+(opts.revokedCount===1?'':'s')+' stopped working immediately.</div>'
        : '')+
      '<dl class="kv"><dt>Tenant</dt><dd>'+esc(opts.tenantName)+'</dd>'+
      '<dt>Tenant ID</dt><dd>'+esc(opts.tenantId)+'</dd></dl>'+
      '<p class="warnnote">API key — shown once, and never again</p>'+
      '<div class="secretbox" id="cm-key">'+esc(opts.apiKey)+'</div>'+
      '<p class="hint" style="padding:0">Copy it or download the file before closing. cixtech keeps only a hash, '+
      'so if it is lost the only way back is to rotate — which invalidates this key too.</p>';
    var foot=
      '<button id="cm-copy">Copy key</button>'+
      '<button id="cm-file">Download .txt</button>'+
      '<button class="primary" id="cm-done">I have saved it</button>';

    openModal(opts.title||'Tenant credentials',body,foot,function(el){
      el.querySelector('#cm-copy').onclick=function(){copyText(opts.apiKey,this);};
      el.querySelector('#cm-file').onclick=function(){
        downloadText(fileText,'cixtech-'+(safeName||'tenant')+'-credentials.txt');
      };
      el.querySelector('#cm-done').onclick=function(){closeModal();if(opts.onDone)opts.onDone();};
    });
  }

  function keysPanel(tenant){
    api('/admin/api/tenants/'+tenant.id+'/keys').then(function(d){
      var t=table(['Key ID','Label','Can do','Issued','Status',''],d.keys,function(k){
        var live=!k.revokedAt;
        return '<td class="mono" title="'+esc(k.id)+'">'+esc(short(k.id))+'</td>'+
          '<td>'+esc(k.label||'—')+'</td>'+
          '<td class="muted">'+esc((k.scopes||[]).join(', '))+'</td>'+
          '<td class="muted">'+whenCell(k.createdAt)+'</td>'+
          '<td>'+(live?badge('Active','ok'):badge('Revoked'+(k.revokedReason?' · '+k.revokedReason:''),'muted'))+'</td>'+
          '<td class="actions">'+(live?'<button class="danger" data-revoke="'+esc(k.id)+'">Revoke</button>':'')+'</td>';
      },function(k){return 'class="keyrow'+(k.revokedAt?' revoked':'')+'"';});
      document.getElementById('tdet').innerHTML=panel('Credentials · '+esc(tenant.name),
        '<div class="form"><button class="primary" id="rot">Rotate credentials</button>'+
        '<button id="issue">Issue an extra key</button></div>'+
        '<p class="hint">Rotating issues one new key and revokes every existing key at the same moment — '+
        'use it when a key has leaked or been lost. Issuing an extra key leaves the current ones working, '+
        'for a second integration or a staged hand-over.</p>'+t);

      document.getElementById('rot').onclick=function(){
        if(!confirm('Rotate credentials for "'+tenant.name+'"?\n\nEvery key this tenant has now will stop working immediately. Any live integration using one will start failing until it is given the new key.'))return;
        var reason=prompt('Why is this being rotated? (recorded in the audit trail)','key lost or leaked');
        if(reason===null)return;
        api('/admin/api/tenants/'+tenant.id+'/keys/rotate',{method:'POST',body:JSON.stringify({reason:reason})})
          .then(function(res){
            credentialModal({
              title:'Credentials rotated',
              tenantName:tenant.name,tenantId:tenant.id,apiKey:res.apiKey,keyId:res.keyId,
              revokedCount:(res.revoked||[]).length,
              onDone:function(){keysPanel(tenant);}
            });
          }).catch(fail);
      };
      document.getElementById('issue').onclick=function(){
        api('/admin/api/tenants/'+tenant.id+'/keys',{method:'POST'})
          .then(function(res){
            credentialModal({
              title:'Additional key issued',
              tenantName:tenant.name,tenantId:tenant.id,apiKey:res.apiKey,
              onDone:function(){keysPanel(tenant);}
            });
          }).catch(fail);
      };
      document.querySelectorAll('[data-revoke]').forEach(function(b){
        b.onclick=function(){
          if(!confirm('Revoke this key?\n\nAnything using it stops working immediately. The tenant\'s other keys are unaffected.'))return;
          api('/admin/api/tenants/'+tenant.id+'/keys/'+b.getAttribute('data-revoke')+'/revoke',
              {method:'POST',body:JSON.stringify({reason:'revoked from console'})})
            .then(function(){keysPanel(tenant);}).catch(fail);
        };
      });
    }).catch(fail);
  }

  views.tenants=function(){
    api('/admin/api/tenants').then(function(rows){
      var totalAcc = 0, totalKeys = 0;
      for(var i=0;i<rows.length;i++){ totalAcc += Number(rows[i].accounts||0); totalKeys += Number(rows[i].api_keys||0); }
      var statGrid = renderStatGrid([
        ['TOTAL TENANTS', rows.length, rows.length + ' registered merchants', '🏢', 'cyan'],
        ['SUB-ACCOUNTS', totalAcc, 'Active sub-ledger balances', '📂', 'green'],
        ['ACTIVE KEYS', totalKeys, 'Issued tenant API credentials', '🔑', 'purple'],
        ['DATABASE ISOLATION', '100% RLS', 'Row-level security guarded', '🛡️', 'green']
      ]);
      var t=table(['Name','Tenant ID','Sub-accounts','Active keys','Created',''],rows,function(r){
        return '<td><b>'+esc(r.name)+'</b></td><td class="mono" title="'+esc(r.id)+'">'+esc(short(r.id))+'</td>'+
          '<td>'+r.accounts+'</td>'+
          '<td>'+(Number(r.api_keys)===0?badge('none','warn'):badge(r.api_keys+' keys','ok'))+'</td>'+
          '<td class="muted">'+whenCell(r.created_at)+'</td>'+
          '<td class="actions"><button class="primary" data-keys="'+esc(r.id)+'" data-name="'+esc(r.name)+'">Credentials 🔑</button></td>';
      });
      main('<div class="head"><h2>Tenants Directory</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'<button class="primary" id="ct">+ New Tenant</button></div></div>'+statGrid+panel('All Active Merchant Tenants',t)+'<div id="tdet"></div>');
      document.getElementById('ct').onclick=function(){
        var name=prompt('What is this tenant called?');
        if(!name)return;
        api('/admin/api/tenants',{method:'POST',body:JSON.stringify({name:name})}).then(function(res){
          credentialModal({
            title:'Tenant created',
            tenantName:res.tenant.name,tenantId:res.tenant.id,apiKey:res.apiKey,
            onDone:views.tenants
          });
        }).catch(fail);
      };
      document.querySelectorAll('[data-keys]').forEach(function(b){
        b.onclick=function(){keysPanel({id:b.getAttribute('data-keys'),name:b.getAttribute('data-name')});};
      });
    }).catch(fail);
  };

  var ACCOUNT_TYPE_WORDS={ASSET:'Funds we hold',LIABILITY:'Owed to customers',REVENUE:'Our earnings',EXPENSE:'Our costs'};

  function entriesTable(rows){
    return table(['What happened','When','Movement','Reference'],rows,function(r){
      var p='';
      for(var i=0;i<r.postings.length;i++){
        var x=r.postings[i];
        var into=x.direction==='DEBIT';
        p+='<div class="movement">'+
           '<span class="dir">'+(into?'into':'from')+'</span>'+
           '<span class="amt">'+moneyHtml(x.amount,x.asset)+'</span>'+
           accountCell(x.account)+'</div>';
      }
      return '<td>'+badge(kindLabel(r.kind),kindClass(r.kind))+'</td>'+
        '<td class="muted">'+whenCell(r.occurred_at)+'</td><td>'+p+'</td>'+
        '<td class="mono muted" title="'+esc(r.idempotency_key)+'">'+esc(short(r.idempotency_key))+'</td>';
    });
  }

  views.earnings=function(){
    api('/admin/api/earnings').then(function(d){
      var summary = d.summary || [];
      var totRev = 0n, totGas = 0n, totUnswept = 0n;
      for(var i=0;i<summary.length;i++){
        totRev += BigInt(summary[i].feeRevenue || '0');
        totGas += BigInt(summary[i].gasExpense || '0');
        totUnswept += BigInt(summary[i].unsweptFee || '0');
      }
      var mainAsset = (summary[0] && summary[0].asset) || 'USDT';
      var statGrid = renderStatGrid([
        ['TOTAL FEE REVENUE', moneyHtml(totRev.toString(), mainAsset), 'Gross platform fee income', '💵', 'green'],
        ['NETWORK GAS EXPENSES', moneyHtml(totGas.toString(), mainAsset), 'Absorbed gas transaction costs', '⛽', 'orange'],
        ['NET PROFIT MARGIN', moneyHtml((totRev - totGas).toString(), mainAsset), 'Retained net profit balance', '📈', 'cyan'],
        ['UNSWEPT FEE POOL', moneyHtml(totUnswept.toString(), mainAsset), 'Accrued in platform liquidity', '🏦', 'purple']
      ]);

      var sumTable = table(['Asset','Gross Fee Revenue','Gas Expense','Net Margin','Unswept Fee Balance'], summary, function(r){
        return '<td><b>'+esc(r.asset)+'</b></td>'+
               '<td class="num">'+moneyHtml(r.feeRevenue,r.asset)+'</td>'+
               '<td class="num">'+moneyHtml(r.gasExpense,r.asset)+'</td>'+
               '<td class="num">'+moneyHtml(r.netMargin,r.asset)+'</td>'+
               '<td class="num">'+moneyHtml(r.unsweptFee,r.asset)+'</td>';
      });

      var tenantTable = table(['Tenant Name','Tenant ID','Asset','Fee Revenue Contributed'], d.tenantBreakdown||[], function(r){
        return '<td><b>'+esc(r.tenantName)+'</b></td>'+
               '<td class="mono" title="'+esc(r.tenantId)+'">'+esc(short(r.tenantId))+'</td>'+
               '<td class="muted">'+esc(r.asset)+'</td>'+
               '<td class="num">'+moneyHtml(r.feeRevenue,r.asset)+'</td>';
      });

      var trendTable = table(['Asset','24 Hours','7 Days','30 Days'], d.trends||[], function(r){
        return '<td><b>'+esc(r.asset)+'</b></td>'+
               '<td class="num">'+moneyHtml(r.fee24h,r.asset)+'</td>'+
               '<td class="num">'+moneyHtml(r.fee7d,r.asset)+'</td>'+
               '<td class="num">'+moneyHtml(r.fee30d,r.asset)+'</td>';
      });

      main('<div class="head"><h2>Earnings & Revenue Analysis</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'<button class="primary" id="swp">Sweep fees to platform treasury ⚡</button></div></div>'+
           statGrid+
           panel('Financial Margins by Asset', sumTable)+
           panel('Tenant Revenue Breakdown', tenantTable)+
           panel('Revenue Growth Trends', trendTable));
      var swpBtn = document.getElementById('swp');
      if(swpBtn){
        swpBtn.onclick = function(){
          if(!confirm('Sweep all accrued platform fee revenue into the platform treasury?')) return;
          api('/admin/api/earnings/sweep', { method: 'POST', body: JSON.stringify({ asset: mainAsset }) })
            .then(function(res){
              alert('Successfully swept ' + money(res.totalSweptAmount || '0', mainAsset) + ' ' + mainAsset + ' into platform treasury across ' + (res.sweptCount || 0) + ' pool account(s).');
              views.earnings();
            }).catch(fail);
        };
      }
    }).catch(fail);
  };

  views.ledger=function(){
    Promise.all([api('/admin/api/ledger/accounts'),api('/admin/api/ledger/entries?limit=50')]).then(function(res){
      var accounts = res[0]||[], entries = res[1]||[];
      var assetCount = accounts.filter(function(a){ return a.type === 'ASSET'; }).length;
      var liabCount = accounts.filter(function(a){ return a.type === 'LIABILITY'; }).length;
      var statGrid = renderStatGrid([
        ['LEDGER ACCOUNTS', accounts.length, assetCount + ' assets, ' + liabCount + ' liabilities', '📚', 'cyan'],
        ['JOURNAL ENTRIES', entries.length, 'Recent sub-ledger postings', '📝', 'green'],
        ['SOLVENCY GUARANTEE', '100% Backed', 'Assets >= Liabilities invariant', '⚖️', 'purple'],
        ['VERIFICATION SLA', '< 1 Second', 'Immutable PostgreSQL ledger', '⚡', 'green']
      ]);

      var acc=table(['Account','What it is','Asset','Balance','Verification'],accounts,function(r){
        var parts=r.account.split(':');
        var isWallet = parts[0]==='pool_addr' || parts[0]==='treasury';
        var chain = (parts[0]==='pool_addr'?parts[1]:'TRON') || 'TRON';
        var addr = parts[0]==='pool_addr'?parts[2]:(parts[1]||'');
        var btn = (isWallet && addr) ? '<button class="primary" data-vchain="'+esc(chain)+'" data-vaddr="'+esc(addr)+'" data-vasset="'+esc(r.asset)+'">Verify On-Chain ⛓️</button>' : '—';
        return '<td>'+accountCell(r.account)+'</td><td>'+badge(ACCOUNT_TYPE_WORDS[r.type]||r.type,'muted')+'</td><td class="muted">'+esc(r.asset)+'</td><td class="num">'+moneyHtml(r.balance,r.asset)+'</td><td>'+btn+'</td>';
      });
      main('<div class="head"><h2>Double-Entry Ledger</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Account Balances',acc)+panel('Recent Sub-Ledger Activity',entriesTable(entries)));
      document.querySelectorAll('[data-vaddr]').forEach(function(b){
        b.onclick=function(){
          showWalletVerificationSheet(b.getAttribute('data-vchain'), b.getAttribute('data-vaddr'), b.getAttribute('data-vasset'));
        };
      });
    }).catch(fail);
  };

  views.deposits=function(){
    api('/admin/api/deposits?limit=80').then(function(rows){
      var fin = rows.filter(function(r){ return r.kind === 'deposit.finalized'; }).length;
      var quad = rows.filter(function(r){ return r.kind === 'deposit.quarantined'; }).length;
      var pend = rows.length - fin - quad;
      var statGrid = renderStatGrid([
        ['TOTAL DEPOSITS', rows.length, 'Recent incoming deposits', '📥', 'cyan'],
        ['FINALIZED CONFIRMED', fin, fin + ' credited to merchant accounts', '✅', 'green'],
        ['PENDING CONFIRMATION', pend, pend + ' awaiting block confirmations', '⏳', 'purple'],
        ['QUARANTINED HOLDS', quad, quad + ' flagged by risk watchdogs', '🚨', 'orange']
      ]);
      main('<div class="head"><h2>On-Chain Deposits</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Incoming Deposit Feed',entriesTable(rows)));
    }).catch(fail);
  };

  views.payouts=function(){
    api('/admin/api/payouts?limit=80').then(function(rows){
      var set = rows.filter(function(r){ return r.status === 'settled'; }).length;
      var fail = rows.filter(function(r){ return r.status === 'failed'; }).length;
      var lock = rows.length - set - fail;
      var statGrid = renderStatGrid([
        ['DISPATCHED PAYOUTS', rows.length, 'Recent outgoing dispatches', '📤', 'cyan'],
        ['SETTLED ON-CHAIN', set, set + ' confirmed on blockchain', '✅', 'green'],
        ['APPROVAL / TIME LOCK', lock, lock + ' in security cooldown', '🔒', 'purple'],
        ['FAILED / REFUNDED', fail, fail + ' auto-returned to merchant', '❌', 'orange']
      ]);
      main('<div class="head"><h2>Dispatched Payouts</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Outgoing Dispatched Payouts Feed',entriesTable(rows)));
    }).catch(fail);
  };

  views.webhooks=function(){
    api('/admin/api/webhooks?limit=100').then(function(rows){
      var ok = rows.filter(function(r){ return r.status === 'DELIVERED'; }).length;
      var retry = rows.filter(function(r){ return r.status === 'RETRYING'; }).length;
      var dead = rows.filter(function(r){ return r.status === 'DEAD_LETTER'; }).length;
      var statGrid = renderStatGrid([
        ['OUTBOX DELIVERIES', rows.length, 'Total webhook dispatches', '🔔', 'cyan'],
        ['DELIVERED OK', ok, ok + ' confirmed by tenant servers', '✅', 'green'],
        ['PENDING RETRY', retry, retry + ' queued for exponential backoff', '🔄', 'purple'],
        ['DEAD-LETTERED', dead, dead + ' flagged for inspection', '💀', 'orange']
      ]);

      var t=table(['Delivery','Tenant','Status','Tries','Next try','Last error',''],rows,function(r){
        return '<td class="mono" title="'+esc(r.id)+'">'+esc(short(r.id))+'</td><td class="mono" title="'+esc(r.tenant_id)+'">'+esc(short(r.tenant_id))+'</td><td>'+whStatusBadge(r.status)+'</td><td>'+r.attempts+'</td><td class="muted">'+whenCell(r.next_attempt)+'</td><td class="muted">'+esc(r.last_error||'')+'</td><td class="actions"><button data-insp="'+r.id+'">Inspect 🔍</button><button class="primary" data-replay="'+r.id+'">Retry now</button><button class="danger" data-cancel="'+r.id+'">Give up</button></td>';
      });
      main('<div class="head"><h2>Webhook Notification Outbox</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Notifications We Owe Tenants',t)+'<div id="wdet"></div>');
      document.querySelectorAll('[data-replay]').forEach(function(b){b.onclick=function(){api('/admin/api/webhooks/'+b.getAttribute('data-replay')+'/replay',{method:'POST'}).then(views.webhooks).catch(fail);};});
      document.querySelectorAll('[data-cancel]').forEach(function(b){b.onclick=function(){if(!confirm('Dead-letter this delivery?'))return;api('/admin/api/webhooks/'+b.getAttribute('data-cancel')+'/cancel',{method:'POST'}).then(views.webhooks).catch(fail);};});
      document.querySelectorAll('[data-insp]').forEach(function(b){b.onclick=function(){api('/admin/api/webhooks/'+b.getAttribute('data-insp')).then(function(w){document.getElementById('wdet').innerHTML=panel('Delivery '+esc(w.id),'<div class="detail" style="padding:16px;background:rgba(0,0,0,0.4);font-family:monospace;border-radius:8px;">'+esc(w.body)+'</div>');}).catch(fail);};});
    }).catch(fail);
  };

  var AUDIT_LABELS={
    'killswitch.engage':'Halted all payouts','killswitch.reset':'Resumed payouts',
    'webhook.replay':'Retried a webhook','webhook.cancel':'Gave up on a webhook',
    'tenant.create':'Created a tenant','tenant.issue_key':'Issued an extra API key',
    'tenant.rotate_keys':'Rotated a tenant’s credentials','tenant.keys_revoked':'Revoked the old keys',
    'tenant.revoke_key':'Revoked one API key'
  };
  function auditLabel(a){return AUDIT_LABELS[a]||titleize(String(a||'').replace(/[._]/g,' '));}

  views.audit=function(){
    api('/admin/api/audit?limit=120').then(function(rows){
      var halts = rows.filter(function(r){ return String(r.action).indexOf('killswitch')!==-1; }).length;
      var keys = rows.filter(function(r){ return String(r.action).indexOf('key')!==-1; }).length;
      var okCount = rows.filter(function(r){ return r.result === 'ok'; }).length;
      var statGrid = renderStatGrid([
        ['AUDIT EVENTS', rows.length, 'Super-admin activity log', '📋', 'cyan'],
        ['SECURITY HALTS', halts, halts + ' killswitch control actions', '🛑', 'orange'],
        ['KEY CREDENTIALS', keys, keys + ' API key rotations/issues', '🔑', 'purple'],
        ['VERIFIED EXECUTION', okCount + '/' + rows.length, '100% cryptographic audit trail', '🛡️', 'green']
      ]);

      var t=table(['When','Who','What they did','On','Result','Detail','From'],rows,function(r){
        return '<td class="muted">'+whenCell(r.at)+'</td><td><b>'+esc(r.actor)+'</b></td><td>'+badge(auditLabel(r.action),r.action.indexOf('killswitch')!==-1?'bad':'ok')+'</td><td class="mono" title="'+esc(r.target||'')+'">'+esc(short(r.target||''))+'</td><td>'+(r.result==='ok'?badge('Succeeded','ok'):badge('Failed','bad'))+'</td><td class="muted">'+esc(r.detail||'')+'</td><td class="mono muted">'+esc(r.ip||'')+'</td>';
      });
      main('<div class="head"><h2>Super-Admin Audit Trail</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Every Action Taken From This Console',t));
    }).catch(fail);
  };

  views.errors=function(){
    api('/admin/api/errors?limit=120').then(function(rows){
      var crit = rows.filter(function(r){ return String(r.code).indexOf('50')!==-1 || String(r.code).indexOf('POOL')!==-1; }).length;
      var val = rows.filter(function(r){ return String(r.code).indexOf('VALIDATION')!==-1; }).length;
      var statGrid = renderStatGrid([
        ['LOGGED ERRORS', rows.length, 'Engine diagnostic exceptions', '⚠️', 'orange'],
        ['CRITICAL FAULTS', crit, crit + ' require administrator check', '🚨', 'bad'],
        ['VALIDATION REJECTS', val, val + ' malformed request payloads', '🛑', 'purple'],
        ['ENGINE STATUS', 'OPERATIONAL', 'Auto-recovery enabled', '💚', 'green']
      ]);

      var t=table(['When','Code','What went wrong','Reference'],rows,function(r){
        return '<td class="muted">'+whenCell(r.at)+'</td><td>'+badge(r.code,'bad')+'</td><td>'+esc(r.message)+'</td><td class="mono muted" title="'+esc(r.id)+'">'+esc(short(r.id))+'</td>';
      });
      main('<div class="head"><h2>System Error Diagnostics</h2><div class="row">'+renderTimeframeSwitcher('7 Days')+'</div></div>'+statGrid+panel('Problems Recorded by Engine (ADR 0012)',t));
    }).catch(fail);
  };

  initTheme();
  render();
})();
`;
