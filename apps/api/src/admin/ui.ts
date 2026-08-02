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
/* Admin identity: blue. Everything else is the shared kit above. */
:root{ --accent:#5b9dff; --accent-hi:#7db2ff; }
.detail{background:var(--bg);border:1px solid var(--line2);border-radius:var(--r-sm);padding:14px;
  margin:0 18px 18px;white-space:pre-wrap;word-break:break-all;font-family:var(--mono);
  font-size:12px;line-height:1.6;max-height:340px;overflow:auto}
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

  var NAV=[['overview','Overview'],['tenants','Tenants'],['ledger','Ledger'],['deposits','Deposits'],['payouts','Payouts'],['webhooks','Webhooks'],['audit','Admin audit'],['errors','Errors']];

  // Decimals come from the server (chain-config is the only source, §16.5). Prime
  // them before any view runs, so no screen can render base units as if they were
  // money. A view is never shown against an empty asset table.
  var assetsReady=null;
  function ensureAssets(){
    if(!assetsReady)assetsReady=api('/admin/api/assets').then(function(d){setAssets(d.assets);});
    return assetsReady;
  }

  function render(){
    if(!token){renderLogin();return;}
    var nav='';
    for(var i=0;i<NAV.length;i++){nav+='<div class="nav'+(NAV[i][0]===view?' active':'')+'" data-nav="'+NAV[i][0]+'">'+navIcon(NAV[i][0])+'<span>'+NAV[i][1]+'</span></div>';}
    root.innerHTML='<div class="shell"><div class="side">'+
      '<div class="brand"><div class="mark">c</div><div><b>cixtech</b><small>super-admin console</small></div></div>'+
      nav+'<div class="spacer"></div><button data-logout>Sign out</button></div>'+
      '<div class="main" id="main"><div class="empty">Loading…</div></div></div>';
    root.querySelectorAll('[data-nav]').forEach(function(n){n.onclick=function(){view=n.getAttribute('data-nav');render();};});
    root.querySelector('[data-logout]').onclick=logout;
    ensureAssets().then(function(){views[view]();}).catch(fail);
  }

  function renderLogin(){
    root.innerHTML='<div class="login"><div class="mark">c</div><h1>cixtech admin</h1><p>Enter the super-admin token to continue.</p><input id="tok" type="password" placeholder="Admin token" autocomplete="off"><button class="primary" id="go">Sign in</button><div class="err" id="le"></div></div>';
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
      setAssets(d.assets);
      var cards=[['Tenants',c.tenants],['Accounts',c.accounts],['Journal entries',c.entries],['Webhooks pending',c.webhooksPending],['Webhooks dead',c.webhooksDead],['Errors 24h',c.errors24h]];
      var cardsH='';for(var i=0;i<cards.length;i++)cardsH+='<div class="card"><div class="k">'+cards[i][0]+'</div><div class="v">'+num(cards[i][1])+'</div></div>';
      var ks=d.killSwitchEngaged;
      var banner=ks?'<div class="banner bad">Kill-switch ENGAGED — all payouts are halted.</div>':'<div class="banner ok">Kill-switch clear — payouts flowing normally.</div>';
      var solv=table(['Asset','Held for customers','Owed to customers','Status'],d.solvency,function(r){
        return '<td>'+esc(r.asset)+'</td><td class="num">'+moneyHtml(r.assets,r.asset)+'</td><td class="num">'+moneyHtml(r.liabilities,r.asset)+'</td><td>'+(r.solvent?badge('Fully backed','ok'):badge('SHORTFALL','bad'))+'</td>';
      });
      var solvNote='<p class="hint">Every asset must hold at least what it owes. A shortfall means customer balances exceed the funds on chain.</p>';
      var lim=d.limits;
      // Limits are configured in base units of the settlement asset; show both so an
      // operator can sanity-check the figure without doing the 10^decimals maths.
      var limitAsset=(d.solvency[0]&&d.solvency[0].asset)||'';
      var limits=panel('Money-out limits',
        '<div class="tablewrap"><table><tbody>'+
        '<tr><td>Most that can leave in one payout</td><td class="num">'+moneyHtml(lim.maxPerPayout,limitAsset)+'</td></tr>'+
        '<tr><td>Rolling window</td><td class="num">'+esc(humanMs(lim.velocityWindowMs))+'</td></tr>'+
        '<tr><td>Most that can leave within that window</td><td class="num">'+moneyHtml(lim.velocityMax,limitAsset)+'</td></tr>'+
        '</tbody></table></div>');
      main('<div class="head"><h2>Overview</h2><div class="row">'+(ks?'<button class="primary" id="ksr">Resume payouts</button>':'<button class="danger" id="kse">Halt all payouts</button>')+'</div></div>'+banner+'<div class="cards">'+cardsH+'</div>'+panel('Are customer funds fully backed?',solv+solvNote)+limits);
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
      var t=table(['Name','Tenant ID','Sub-accounts','Active keys','Created',''],rows,function(r){
        return '<td>'+esc(r.name)+'</td><td class="mono" title="'+esc(r.id)+'">'+esc(short(r.id))+'</td>'+
          '<td>'+r.accounts+'</td>'+
          '<td>'+(Number(r.api_keys)===0?badge('none','warn'):r.api_keys)+'</td>'+
          '<td class="muted">'+whenCell(r.created_at)+'</td>'+
          '<td class="actions"><button data-keys="'+esc(r.id)+'" data-name="'+esc(r.name)+'">Credentials</button></td>';
      });
      main('<div class="head"><h2>Tenants</h2><button class="primary" id="ct">New tenant</button></div>'+panel('All tenants',t)+'<div id="tdet"></div>');
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

  // Each row is one balanced entry: money left some accounts and arrived in others.
  // Money-in is shown as a credit to the destination, so the two sides read as
  // "from" and "to" rather than as DEBIT/CREDIT jargon.
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
  views.ledger=function(){
    Promise.all([api('/admin/api/ledger/accounts'),api('/admin/api/ledger/entries?limit=50')]).then(function(res){
      var acc=table(['Account','What it is','Asset','Balance'],res[0],function(r){
        return '<td>'+accountCell(r.account)+'</td><td>'+badge(ACCOUNT_TYPE_WORDS[r.type]||r.type,'muted')+'</td><td class="muted">'+esc(r.asset)+'</td><td class="num">'+moneyHtml(r.balance,r.asset)+'</td>';
      });
      main('<div class="head"><h2>Ledger</h2></div>'+panel('Balances',acc)+panel('Recent activity',entriesTable(res[1])));
    }).catch(fail);
  };
  views.deposits=function(){api('/admin/api/deposits?limit=80').then(function(rows){main('<div class="head"><h2>Deposits</h2></div>'+panel('Money in',entriesTable(rows)));}).catch(fail);};
  views.payouts=function(){api('/admin/api/payouts?limit=80').then(function(rows){main('<div class="head"><h2>Payouts</h2></div>'+panel('Money out',entriesTable(rows)));}).catch(fail);};

  views.webhooks=function(){
    api('/admin/api/webhooks?limit=100').then(function(rows){
      var t=table(['Delivery','Tenant','Status','Tries','Next try','Last error',''],rows,function(r){
        return '<td class="mono" title="'+esc(r.id)+'">'+esc(short(r.id))+'</td><td class="mono" title="'+esc(r.tenant_id)+'">'+esc(short(r.tenant_id))+'</td><td>'+whStatusBadge(r.status)+'</td><td>'+r.attempts+'</td><td class="muted">'+whenCell(r.next_attempt)+'</td><td class="muted">'+esc(r.last_error||'')+'</td><td class="actions"><button data-insp="'+r.id+'">Inspect</button><button data-replay="'+r.id+'">Retry now</button><button class="danger" data-cancel="'+r.id+'">Give up</button></td>';
      });
      main('<div class="head"><h2>Webhook outbox</h2></div>'+panel('Notifications we owe tenants',t)+'<div id="wdet"></div>');
      document.querySelectorAll('[data-replay]').forEach(function(b){b.onclick=function(){api('/admin/api/webhooks/'+b.getAttribute('data-replay')+'/replay',{method:'POST'}).then(views.webhooks).catch(fail);};});
      document.querySelectorAll('[data-cancel]').forEach(function(b){b.onclick=function(){if(!confirm('Dead-letter this delivery?'))return;api('/admin/api/webhooks/'+b.getAttribute('data-cancel')+'/cancel',{method:'POST'}).then(views.webhooks).catch(fail);};});
      document.querySelectorAll('[data-insp]').forEach(function(b){b.onclick=function(){api('/admin/api/webhooks/'+b.getAttribute('data-insp')).then(function(w){document.getElementById('wdet').innerHTML=panel('Delivery '+esc(w.id),'<div class="detail">'+esc(w.body)+'</div>');}).catch(fail);};});
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
      var t=table(['When','Who','What they did','On','Result','Detail','From'],rows,function(r){
        return '<td class="muted">'+whenCell(r.at)+'</td><td>'+esc(r.actor)+'</td><td>'+esc(auditLabel(r.action))+'</td><td class="mono" title="'+esc(r.target||'')+'">'+esc(short(r.target||''))+'</td><td>'+(r.result==='ok'?badge('Succeeded','ok'):badge('Failed','bad'))+'</td><td class="muted">'+esc(r.detail||'')+'</td><td class="mono muted">'+esc(r.ip||'')+'</td>';
      });
      main('<div class="head"><h2>Admin audit trail</h2></div>'+panel('Every action taken from this console',t));
    }).catch(fail);
  };
  views.errors=function(){
    api('/admin/api/errors?limit=120').then(function(rows){
      var t=table(['When','Code','What went wrong','Reference'],rows,function(r){
        return '<td class="muted">'+whenCell(r.at)+'</td><td>'+badge(r.code,'bad')+'</td><td>'+esc(r.message)+'</td><td class="mono muted" title="'+esc(r.id)+'">'+esc(short(r.id))+'</td>';
      });
      main('<div class="head"><h2>Errors</h2></div>'+panel('Problems the engine recorded (ADR 0012)',t));
    }).catch(fail);
  };

  render();
})();
`;
