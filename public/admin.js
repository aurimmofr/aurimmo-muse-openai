const $=selector=>document.querySelector(selector);

const state={clients:[],filtered:[],reconciliations:[],loaded:false,resolving:new Set()};

const planLabels={essential:'Essentiel',pro:'Pro'};
const intervalLabels={month:'mensuel',year:'annuel'};
const statusLabels={
  active:'Actif',trialing:'Actif',past_due:'Paiement requis',canceled:'Résilié',paused:'Suspendu',
  incomplete:'À finaliser',incomplete_expired:'Expiré',unpaid:'Impayé',unknown:'État inconnu',none:'Sans abonnement',
};

function numeric(value) {
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?Math.round(number):0;
}

function shortId(value) {
  const text=String(value||'');
  return text.length>18?`${text.slice(0,8)}…${text.slice(-6)}`:text||'—';
}

function formatDate(value,{long=false}={}) {
  if(!value)return '—';
  const date=new Date(value);
  if(Number.isNaN(date.valueOf()))return '—';
  return new Intl.DateTimeFormat('fr-FR',long?{dateStyle:'medium',timeStyle:'short'}:{day:'2-digit',month:'short',year:'numeric'}).format(date);
}

function plural(count,singular,pluralForm=`${singular}s`) {
  return `${numeric(count)} ${numeric(count)>1?pluralForm:singular}`;
}

function setText(selector,value) {
  const element=$(selector);
  if(element)element.textContent=String(value);
}

function element(tag,{className,text,title}={}) {
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=String(text);
  if(title)node.title=title;
  return node;
}

async function api(path,{method='GET',body,timeoutMs=15_000}={}) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const headers={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await response.text();
    let data={};
    try{data=raw?JSON.parse(raw):{};}catch{}
    if(!response.ok) {
      const error=new Error(typeof data.error==='string'?data.error:'Le service est momentanément indisponible.');
      error.status=response.status;
      throw error;
    }
    return data;
  } catch(error) {
    if(error.name==='AbortError')throw Object.assign(new Error('Le service met trop de temps à répondre.'),{status:503});
    throw error;
  } finally {clearTimeout(timeout);}
}

function setSync(mode,label,time='') {
  const dot=$('#sync-dot');
  dot.classList.remove('live','error');
  if(mode==='live')dot.classList.add('live');
  if(mode==='error')dot.classList.add('error');
  setText('#sync-label',label);
  setText('#sync-time',time||'—');
}

function showFeedback(message,type='') {
  const box=$('#feedback');
  box.textContent=message;
  box.className=`feedback${type?` ${type}`:''}`;
  box.hidden=!message;
}

function showAccess(status,message) {
  $('#dashboard').hidden=true;
  $('#access-state').hidden=false;
  setSync('error',status===403?'Accès refusé':'Connexion requise');
  setText('#access-title',status===403?'Ce compte n’est pas administrateur.':'Connexion requise');
  setText('#access-copy',message||(status===403?'Utilisez un compte autorisé dans la configuration ADMIN_EMAILS.':'Connectez-vous avec un compte administrateur autorisé.'));
  const link=$('#access-link');
  link.textContent=status===403?'Revenir à mon espace':'Se connecter';
  link.href=status===403?'/portal.html':'/portal.html?view=login&return_to=%2Fadmin.html';
}

function percentage(value,total) {
  return total>0?Math.round((numeric(value)/total)*100):0;
}

function renderSummary(data) {
  const summary=data.summary||{},plans=summary.plans||{},credits=summary.credits||{},generations=summary.generations||{};
  const active=numeric(summary.active_subscriptions),essential=numeric(plans.essential),pro=numeric(plans.pro);
  setText('#metric-clients',numeric(summary.clients));
  setText('#metric-onboarded',plural(summary.onboarded,'parcours complété','parcours complétés'));
  setText('#metric-subscriptions',active);
  setText('#metric-plan-mix',`${essential} Essentiel · ${pro} Pro`);
  setText('#metric-consumed',numeric(credits.consumed));
  setText('#metric-reserved',numeric(credits.reserved));
  setText('#metric-saved',numeric(generations.saved));
  setText('#metric-generations-total',plural(generations.total,'tentative'));
  setText('#metric-reconciliation',numeric(generations.reconciliation_required));
  setText('#plans-total',plural(active,'actif','actifs'));
  setText('#essential-count',plural(essential,'client'));
  setText('#pro-count',plural(pro,'client'));
  const essentialPercent=percentage(essential,active),proPercent=percentage(pro,active);
  setText('#essential-percent',`${essentialPercent}%`);
  setText('#pro-percent',`${proPercent}%`);
  $('#essential-bar').style.width=`${essentialPercent}%`;
  $('#pro-bar').style.width=`${proPercent}%`;
  setText('#activity-saved',numeric(generations.saved));
  setText('#activity-started',numeric(generations.request_started));
  setText('#activity-reserved',numeric(generations.reserved));
  setText('#activity-failed',numeric(generations.failed_before_request));
  setText('#activity-failed-after',numeric(generations.failed_after_request));
  setText('#metric-credits-period','Périodes client en cours');
}

function statusClass(subscription) {
  if(subscription?.active)return 'active';
  if(['past_due','incomplete','unpaid'].includes(subscription?.status))return 'warning';
  if(['canceled','incomplete_expired'].includes(subscription?.status))return 'danger';
  return '';
}

function clientName(client) {
  const name=[client.first_name,client.last_name].filter(Boolean).join(' ').trim();
  return name||client.company_name||'Client sans nom';
}

function subscriptionCell(client) {
  const cell=element('td',{className:'subscription-cell'});
  const subscription=client.subscription;
  if(!subscription) {
    cell.append(element('span',{className:'status-pill',text:'Sans abonnement'}));
    return cell;
  }
  const label=statusLabels[subscription.status]||'État inconnu';
  cell.append(element('span',{className:`status-pill ${statusClass(subscription)}`,text:label}));
  const plan=planLabels[subscription.plan_code]||'Offre inconnue';
  const interval=intervalLabels[subscription.billing_interval]||'période inconnue';
  cell.append(element('small',{text:`${plan} · ${interval}`}));
  if(subscription.cancel_at_period_end)cell.append(element('small',{text:'Résiliation en fin de période'}));
  return cell;
}

function creditCell(client) {
  const usage=client.usage||{},included=numeric(usage.included),consumed=numeric(usage.consumed),reserved=numeric(usage.reserved);
  const cell=element('td',{className:'credit-cell'});
  if(!included) {
    cell.append(element('strong',{text:'—'}),element('small',{text:'Aucune période active'}));
    return cell;
  }
  cell.append(element('strong',{text:`${consumed} / ${included} consommés`}));
  cell.append(element('small',{text:reserved?`${reserved} réservé${reserved>1?'s':''}`:`${numeric(usage.remaining)} disponible${numeric(usage.remaining)>1?'s':''}`}));
  const progress=element('div',{className:'mini-progress'}),bar=element('span');
  bar.style.width=`${Math.min(100,Math.round(((consumed+reserved)/included)*100))}%`;
  progress.append(bar);cell.append(progress);
  return cell;
}

function rowFor(client) {
  const row=document.createElement('tr');
  const identity=element('td'),wrap=element('div',{className:'client-cell'});
  const name=clientName(client),avatar=element('span',{className:'client-avatar',text:name.slice(0,1).toUpperCase()||'A'});
  const copy=element('span'),title=element('strong',{text:name,title:name});
  const detail=[client.email,client.company_name&&client.company_name!==name?client.company_name:null,shortId(client.user_id)].filter(Boolean).join(' · ');
  copy.append(title,element('small',{text:detail,title:client.user_id}));wrap.append(avatar,copy);identity.append(wrap);row.append(identity);
  row.append(subscriptionCell(client));
  row.append(creditCell(client));

  const generation=client.generations||{},generationCell=element('td',{className:'generation-cell'});
  generationCell.append(element('span',{className:'numeric-cell',text:numeric(generation.saved)}),element('small',{text:`sur ${numeric(generation.total)} tentative${numeric(generation.total)>1?'s':''}`}));
  if(numeric(generation.reconciliation_required))generationCell.append(element('small',{text:`${numeric(generation.reconciliation_required)} à réconcilier`}));
  row.append(generationCell);

  const projectCell=element('td');
  projectCell.append(element('span',{className:'numeric-cell',text:numeric(client.projects)}));
  row.append(projectCell);

  const dateCell=element('td',{className:'date-cell'});
  dateCell.append(element('span',{text:formatDate(client.last_activity_at)}));
  dateCell.append(element('small',{text:client.onboarding_completed?'Parcours complété':'Parcours à terminer'}));
  row.append(dateCell);
  return row;
}

function filterClients() {
  const search=$('#search-input').value.trim().toLocaleLowerCase('fr-FR');
  const plan=$('#plan-filter').value,status=$('#status-filter').value;
  state.filtered=state.clients.filter(client=>{
    const haystack=[client.email,client.first_name,client.last_name,client.company_name,client.user_id].filter(Boolean).join(' ').toLocaleLowerCase('fr-FR');
    if(search&&!haystack.includes(search))return false;
    if(plan==='none'&&client.subscription?.plan_code)return false;
    if(plan!=='all'&&plan!=='none'&&client.subscription?.plan_code!==plan)return false;
    if(status==='none'&&client.subscription)return false;
    if(status==='active'&&!client.subscription?.active)return false;
    if(!['all','none','active'].includes(status)&&client.subscription?.status!==status)return false;
    return true;
  });
  renderClients();
}

function renderClients() {
  const body=$('#clients-body');body.replaceChildren(...state.filtered.map(rowFor));
  $('#empty-state').hidden=state.filtered.length>0;
  setText('#visible-count',plural(state.filtered.length,'client'));
}

function reconciliationClient(item) {
  return state.clients.find(client=>client.user_id===item.user_id)||null;
}

async function resolveAttempt(item,resolution,note,container) {
  if(state.resolving.has(item.authorization_id))return;
  const normalized=note.replace(/\s+/g,' ').trim();
  if(normalized.length<10) {
    showFeedback('Ajoutez une note d’au moins 10 caractères décrivant la vérification effectuée.','error');
    container.querySelector('textarea')?.focus();
    return;
  }
  const saved=resolution==='confirmed_saved';
  const question=saved
    ?'Confirmer ce rendu stocké ? L’image et sa trace seront vérifiées strictement. Aucun appel Muse ne sera lancé.'
    :'Clôturer cette tentative sans rendu exploitable ? Le crédit déjà consommé restera consommé et aucun appel Muse ne sera lancé.';
  if(!window.confirm(question))return;
  state.resolving.add(item.authorization_id);
  for(const control of container.querySelectorAll('button,textarea'))control.disabled=true;
  showFeedback('Rapprochement en cours…');
  try {
    await api('/api/admin-reconciliations',{method:'POST',timeoutMs:30_000,body:{authorization_id:item.authorization_id,run_id:item.run_id,resolution,note:normalized}});
    await load();
    showFeedback(saved?'Rendu stocké confirmé et tentative résolue. Aucun appel Muse effectué.':'Tentative clôturée sans rendu exploitable. Aucun appel Muse effectué.');
  } catch(error) {
    showFeedback(error.message||'Le rapprochement a échoué.','error');
    for(const control of container.querySelectorAll('button,textarea'))control.disabled=false;
  } finally {state.resolving.delete(item.authorization_id);}
}

function reconciliationItem(item) {
  const container=element('article',{className:'reconciliation-item'}),client=reconciliationClient(item);
  const identity=element('div',{className:'reconciliation-identity'});
  identity.append(
    element('strong',{text:client?clientName(client):'Client non affiché'}),
    element('small',{text:item.run_id,title:item.run_id}),
    element('small',{text:`Début : ${formatDate(item.request_started_at||item.created_at,{long:true})}`}),
  );
  const form=element('div',{className:'reconciliation-form'}),label=element('label',{text:'NOTE DE VÉRIFICATION OBLIGATOIRE'}),note=document.createElement('textarea');
  const noteId=`reconciliation-note-${item.authorization_id}`;label.htmlFor=noteId;note.id=noteId;note.minLength=10;note.maxLength=500;note.placeholder='Ex. image et trace contrôlées dans le stockage privé.';
  form.append(label,note,element('small',{text:'10 à 500 caractères · décision et auteur conservés dans l’audit'}));
  const actions=element('div',{className:'reconciliation-actions'}),confirmSaved=element('button',{className:'button button-confirm',text:'Confirmer le rendu stocké'}),closeWithout=element('button',{className:'button button-danger',text:'Clôturer sans rendu'});
  confirmSaved.type='button';closeWithout.type='button';
  confirmSaved.addEventListener('click',()=>resolveAttempt(item,'confirmed_saved',note.value,container));
  closeWithout.addEventListener('click',()=>resolveAttempt(item,'confirmed_no_result',note.value,container));
  actions.append(confirmSaved,closeWithout);container.append(identity,form,actions);return container;
}

function renderReconciliations() {
  const list=$('#reconciliations-list'),empty=$('#reconciliations-empty'),items=state.reconciliations;
  list.replaceChildren(...items.map(reconciliationItem));
  empty.hidden=items.length>0;
  setText('#reconciliations-count',plural(items.length,'tentative'));
}

function render(data) {
  state.clients=Array.isArray(data.clients)?data.clients:[];
  state.reconciliations=Array.isArray(data.reconciliations)?data.reconciliations:[];
  state.filtered=state.clients;
  setText('#admin-email',data.admin?.email||'');
  renderSummary(data);renderClients();renderReconciliations();
  $('#access-state').hidden=true;$('#dashboard').hidden=false;
  const generated=formatDate(data.generated_at,{long:true});
  setSync('live','Données synchronisées',generated);
  showFeedback(data.partial?'Le volume de données dépasse la limite du tableau : les indicateurs affichés sont partiels.':'',data.partial?'warning':'');
}

async function load() {
  const button=$('#refresh-button');
  button.disabled=true;setSync('',state.loaded?'Actualisation…':'Connexion aux données…');
  try {
    const data=await api('/api/admin-clients');
    state.loaded=true;render(data);
  } catch(error) {
    if(error.status===401||error.status===403)return showAccess(error.status,error.message);
    setSync('error','Synchronisation impossible');
    showFeedback(error.message||'Le suivi clients est momentanément indisponible.','error');
    if(!state.loaded)showAccess(503,'Le suivi clients est momentanément indisponible. Réessayez dans quelques instants.');
  } finally {button.disabled=false;}
}

$('#filters').addEventListener('input',filterClients);
$('#filters').addEventListener('change',filterClients);
$('#refresh-button').addEventListener('click',load);
$('#logout-button').addEventListener('click',async()=>{
  const button=$('#logout-button');button.disabled=true;
  try{await api('/api/client-auth',{method:'DELETE'});}catch{}
  location.assign('/portal.html');
});

load();
