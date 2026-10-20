const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function renderSupportConsentPage({ nonce, csrf, basePath }) {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="support-csrf" content="${escape(csrf)}"><meta name="support-base" content="${escape(basePath)}">
<title>Tijdelijke support · SmartAF</title><style nonce="${escape(nonce)}">
body{font:17px/1.5 system-ui,sans-serif;background:#f3f5f7;color:#18252f;margin:0;padding:24px}main{max-width:720px;margin:auto}section{background:white;border:1px solid #dbe2e8;border-radius:14px;padding:24px;margin:18px 0}h1{font-size:1.8rem;line-height:1.2}h2{font-size:1.25rem}label{display:block;margin:12px 0}fieldset{border:1px solid #dbe2e8;border-radius:8px;margin:18px 0;padding:14px}select,button{font:inherit;padding:10px;border:1px solid #698193;border-radius:6px;max-width:100%}button{background:#123f55;color:white;cursor:pointer;margin:8px 8px 8px 0}button:disabled{opacity:.5;cursor:default}input{margin-right:8px}#message{font-weight:600}li{margin:6px 0}.muted{color:#506270}.danger{background:#792e26}code{overflow-wrap:anywhere} [hidden]{display:none!important}
</style></head><body><main><h1>Tijdelijke support</h1>
<p>Geef het getoonde supportaccount tijdelijk toestemming om een probleem te onderzoeken. Controleer de gevraagde gegevens en stop de toegang wanneer je wilt.</p>
<p class="muted">Alleen verbindingsstatus, bereikbaarheid en afgeschermde foutmeldingen. Geen bediening van apparaten, ruwe woningwaarden, vrije logbestanden of terminaltoegang. De toestemming duurt maximaal 30 minuten.</p>
<p id="message" role="status" aria-live="polite">Status ophalen…</p>
<section id="choose" hidden><h2>1. Kies een supportaanvraag</h2><label>Aanvraag <select id="proposal"></select></label>
<p>Je kunt alleen de hieronder getoonde aanvraag goedkeuren. Wil je minder gegevens delen of een kortere duur, laat de beheerder dan een nieuwe aanvraag maken.</p>
<button id="prepare" type="button">Controleer de toestemming</button></section>
<section id="review" hidden><h2>2. Controleer en geef toestemming</h2><div id="summary"></div>
<p>Dit voorstel is één minuut geldig. Controleer de beheerder, gegevens en eindtijd voordat je toestemming geeft.</p>
<button id="approve" type="button">Ik geef tijdelijk toestemming</button><button id="decline" class="danger" type="button">Wijs deze aanvraag af</button><button id="cancel" type="button">Terug</button></section>
<section><h2>Lokaal goedgekeurde toegang</h2><p class="muted">Deze pagina bevestigt jouw lokale toestemming. Of de beheerder de bevestiging heeft ontvangen, is hier nog niet gecontroleerd.</p><div id="grants">Geen lokale toestemming.</div><button id="refresh" type="button">Status vernieuwen</button></section>
<p class="muted">Bij verbindingsverlies of herstart vervalt de toestemming. Een nieuwe verbinding geeft de beheerder geen nieuwe toestemming.</p>
</main><script nonce="${escape(nonce)}">
'use strict';
const csrf=document.querySelector('meta[name="support-csrf"]').content;
const base=document.querySelector('meta[name="support-base"]').content;
const names={read_health:'Verbindingsstatus van Home Assistant en SmartAF',read_entity_availability:'Bereikbaarheid van de gekozen apparaten',read_command_results:'Afgeschermde uitvoerresultaten vanaf de aanvraagtijd',read_incident_log:'Afgeschermde foutcodes vanaf de aanvraagtijd'};
const messages={support_disabled:'Support staat uit in jouw lokale instellingen.',support_transport_unavailable:'De diagnoseverbinding is nog niet beschikbaar.',session_expired:'Deze pagina is verlopen. Open de supportpagina opnieuw via Home Assistant.',review_expired:'Het voorstel is verlopen. Controleer de toestemming opnieuw.',scope_denied:'Deze keuze valt buiten de toegestane toegang.',csrf_required:'De sessie kan niet worden bevestigd. Open de pagina opnieuw via Home Assistant.',clock_untrusted:'De lokale klok is niet betrouwbaar. Support is geblokkeerd.'};
const el=id=>document.getElementById(id);
let draft=null,busy=false,display={entities:{}},scopeEntities=[];
function say(text){el('message').textContent=text;}
async function api(path,body){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'content-type':'application/json','x-support-csrf':csrf},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(messages[value.error]||'De aanvraag is geweigerd. Open de pagina opnieuw of controleer de lokale instellingen.');return value;}
function list(parent,values,label=value=>value){const ul=document.createElement('ul');values.forEach(value=>{const li=document.createElement('li');li.textContent=label(value);ul.append(li);});parent.append(ul);}
function entityName(entity){return Object.hasOwn(display.entities,entity)?display.entities[entity]:entity;}
function unambiguousEntityName(entity,requested){const name=entityName(entity),key=name.normalize('NFC').toLocaleLowerCase('nl-NL');const known=new Set([...scopeEntities,...Object.keys(display.entities),...requested]);return [...known].filter(other=>entityName(other).normalize('NFC').toLocaleLowerCase('nl-NL')===key).length>1?name+' ('+entity+')':name;}
function details(parent,value){
  parent.replaceChildren();
  for(const [label,text]of[['Woning',display.home_name||value.home_id],['Supportaccount',value.operator_id]]){const row=document.createElement('p');row.textContent=label+': '+text;parent.append(row);}
  list(parent,value.actions,action=>names[action]);
  if(value.entities.length)list(parent,value.entities,entity=>unambiguousEntityName(entity,value.entities));
  const start=document.createElement('p');start.textContent='Aanvraagtijd: '+new Date(value.issued_at).toLocaleString('nl-NL')+'.';
  const end=document.createElement('p');end.textContent='Toegang stopt op '+new Date(value.expires_at).toLocaleString('nl-NL')+'. Deze eindtijd schuift niet op wanneer je toestemming geeft.';
  const technical=document.createElement('details'),heading=document.createElement('summary');heading.textContent='Technische details van deze aanvraag';technical.append(heading);
  for(const [label,key]of[['Woning','home_id'],['Incident','incident_id'],['Supportaccount','operator_id']]){const row=document.createElement('p');row.textContent=label+': '+value[key];technical.append(row);}
  list(technical,value.actions);if(value.entities.length)list(technical,value.entities,entity=>entityName(entity)+' — '+entity);
  parent.append(start,end,technical);
}
async function refresh(){const state=await api('/api/state');display=state.display||{entities:{}};scopeEntities=state.entities||[];say(!state.enabled?'Support staat uit in jouw lokale instellingen.':!state.connected?'De diagnoseverbinding is nog niet gekoppeld of niet beschikbaar.':!state.proposals.length?'Er zijn geen nieuwe supportaanvragen.':'Er staat een supportaanvraag klaar voor jouw controle.');el('choose').hidden=!state.enabled||!state.connected||!!draft||!state.proposals.length;el('proposal').replaceChildren();state.proposals.forEach(value=>{const option=document.createElement('option');option.value=value.grant_id;option.textContent=value.operator_id+' — eindtijd '+new Date(value.expires_at).toLocaleTimeString('nl-NL');el('proposal').append(option);});el('grants').replaceChildren();if(!state.grants.length)el('grants').textContent='Geen actieve toestemming.';state.grants.forEach(grant=>{const item=document.createElement('div'),content=document.createElement('div'),button=document.createElement('button');details(content,grant);button.type='button';button.className='danger';button.textContent='Stop deze toegang';button.addEventListener('click',()=>run(async()=>{await api('/api/revoke',{grant_id:grant.grant_id});await refresh();say('De toegang is gestopt.');}));item.append(content,button);el('grants').append(item);});}
async function run(action){if(busy)return;busy=true;document.querySelectorAll('button').forEach(button=>button.disabled=true);try{await action();}catch(error){say(error.message);}finally{busy=false;document.querySelectorAll('button').forEach(button=>button.disabled=false);}}
el('prepare').addEventListener('click',()=>run(async()=>{draft=await api('/api/prepare',{grant_id:el('proposal').value});details(el('summary'),draft);el('choose').hidden=true;el('review').hidden=false;say('Controleer het voorstel. Er is nog geen toestemming gegeven.');}));
el('approve').addEventListener('click',()=>run(async()=>{if(!draft)return;await api('/api/approve',{draft_id:draft.draft_id,confirm:true});draft=null;el('review').hidden=true;await refresh();say('Lokaal goedgekeurd. Centrale ontvangst is nog niet gecontroleerd. Je kunt de toestemming hieronder direct stoppen.');}));
el('cancel').addEventListener('click',()=>run(async()=>{draft=null;el('review').hidden=true;await refresh();}));
el('decline').addEventListener('click',()=>run(async()=>{if(!draft)return;await api('/api/revoke',{grant_id:draft.grant_id});draft=null;el('review').hidden=true;await refresh();say('De aanvraag is afgewezen. Er is geen toegang gegeven.');}));
el('refresh').addEventListener('click',()=>run(refresh));
run(refresh);
</script></body></html>`;
}
