import {selectProductsByRole} from './random-selection.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const PROGRAMMES = [
  {id:'living_conversation',title:'Salon de conversation',description:'Un salon convivial organisé autour des échanges, sans télévision.'},
  {id:'living_reading',title:'Coin lecture',description:'Un espace calme avec fauteuil, éclairage et rangements, sans télévision.'},
  {id:'living_tv',title:'Salon avec TV',description:'Des assises orientées vers une télévision générique et un meuble TV catalogue.'},
  {id:'living_dining',title:'Salon + repas',description:'Deux fonctions lisibles et une circulation préservée dans la même pièce.'},
];

const PLANS = {
  living_conversation:['sofa','armchair','coffee_table','rug','floor_lamp','decorative_object'],
  living_reading:['armchair','side_table','floor_lamp','rug','bookcase','table_lamp'],
  living_tv:['sofa','armchair','coffee_table','rug','floor_lamp','tv_unit'],
  living_dining:['sofa','coffee_table','rug','dining_table','dining_chair','pendant'],
};

const ROLE_LABELS = {
  sofa:'Canapé',armchair:'Fauteuil',coffee_table:'Table basse',rug:'Tapis',floor_lamp:'Lampadaire',
  artwork:'Décoration murale',decorative_object:'Objet décoratif',side_table:'Table d’appoint',
  bookcase:'Bibliothèque',table_lamp:'Lampe à poser',tv_unit:'Meuble TV',dining_table:'Table de repas',
  dining_chair:'Chaise de repas',pendant:'Suspension',floor_finish:'Finition du sol',wall_finish:'Finition murale',
  sideboard:'Buffet',console:'Console',pouf:'Pouf',wall_lamp:'Applique',ceiling_lamp:'Plafonnier',mirror:'Miroir',
  plant:'Végétal décoratif',planter:'Cache-pot',basket:'Panier',cushion:'Coussin',throw:'Plaid',
};

function cartStorageKey() {
  const userId=state.client?.user?.id||state.client?.user_id||null;
  return userId&&state.projectId?`aurimmo-public-cart:${userId}:${state.projectId}`:null;
}

function savedCart() {
  const key=cartStorageKey();if(!key)return [];
  try {
    const value=JSON.parse(localStorage.getItem(key)||'[]');
    return Array.isArray(value)?value.filter(item=>typeof item==='string').slice(0,100):[];
  } catch { return []; }
}

function persistCart() {
  const key=cartStorageKey();if(!key)return;
  localStorage.setItem(key,JSON.stringify(state.cart));
}

const state = {
  catalogue:[], catalogueRoles:[], catalogueActiveTotal:0, catalogueHistoricalTotal:0, providers:{}, generationEnabled:false, hotspotWorkerReady:false, provider:'muse', programme:null, includeTV:false,
  surfaces:{floor:'preserve',walls:'preserve'}, forcedByRole:{}, selection:[], fingerprint:null, selectionOrigin:null, compositionVersion:0,
  photoPath:null, photoAssetId:null, photoURL:null, photoName:null, width:null, height:null, photoDeletable:false,
  results:{}, history:[], view:'original', compare:false, busy:false, initialized:false, cart:[], client:null, projectId:null,
  explorer:{query:'',role:'',page:0,limit:18},hotspots:new Map(),hotspotVisible:true,hotspotTimer:null,hotspotPollingRun:null,historyOpenToken:0,
};

const GENERATION_INTENT_KEY='aurimmo-generation-intent-v1';

function currentGenerationIntent() {
  return JSON.stringify({user_id:state.client?.user?.id||state.client?.user_id||null,project_id:state.projectId,source_asset_id:state.photoAssetId,
    selection_fingerprint:state.fingerprint,provider:'muse'});
}

function generationAuthorization() {
  const intent=currentGenerationIntent();
  try {
    const pending=JSON.parse(sessionStorage.getItem(GENERATION_INTENT_KEY)||'null');
    if(pending?.intent===intent&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(pending.authorization_id))return pending.authorization_id;
  } catch {}
  const authorizationId=crypto.randomUUID();
  try {sessionStorage.setItem(GENERATION_INTENT_KEY,JSON.stringify({intent,authorization_id:authorizationId,created_at:Date.now()}));}catch{}
  return authorizationId;
}

function clearGenerationAuthorization(authorizationId) {
  try {
    const pending=JSON.parse(sessionStorage.getItem(GENERATION_INTENT_KEY)||'null');
    if(!authorizationId||pending?.authorization_id===authorizationId)sessionStorage.removeItem(GENERATION_INTENT_KEY);
  } catch {try{sessionStorage.removeItem(GENERATION_INTENT_KEY);}catch{}}
}

async function api(path,options={}) {
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
  let payload;
  try { payload=await response.json(); } catch { payload={error:'Réponse serveur illisible.'}; }
  if(!response.ok)throw Object.assign(new Error(payload.error||'Action impossible.'),{status:response.status,payload});
  return payload;
}

function node(tag,className,text) {
  const element=document.createElement(tag);
  if(className)element.className=className;
  if(text!==undefined)element.textContent=String(text);
  return element;
}

function providerLabel() { return 'Muse Image'; }
function programmeLabel(programme=state.programme) { return PROGRAMMES.find(item=>item.id===programme)?.title||'Aménagement non choisi'; }

function money(product) {
  if(!Number.isFinite(product?.price))return 'Prix non certifié';
  return new Intl.NumberFormat('fr-FR',{style:'currency',currency:product.currency||'EUR'}).format(product.price);
}

function costLabel(result) {
  if(!result)return '';
  return result.request_started===false?'Crédit non utilisé':'1 crédit utilisé';
}

function setFeedback(title,text,{error=false,busy=false}={}) {
  const box=$('#run-feedback');
  box.classList.remove('hidden');box.classList.toggle('error',error);
  $('#run-feedback-title').textContent=title;$('#run-feedback-text').textContent=text;
  $('#run-spinner').classList.toggle('hidden',!busy);
}

function hideUnsupportedControls() {
  for(const selector of [
    '#prepare-button','#prepare-feedback','#historical-cost-box','#run-button','#historical-paid-note',
    '#preview-propose-button','#expert-workflow','#proposal-recovery-panel','#service-error-recovery-panel',
    '#result-review-controls','#previous-service-error-notice','#review-link',
    '#dynamic-pool-section','#historical-reference-panel','#historical-uncertainties','#tab-reference',
    '#reference-thumbnail','#flux3-only-button'
  ]) $(selector)?.classList.add('hidden');
  $('#selection-preview-note').textContent='Chaque nouvelle composition tire gratuitement des références actives au hasard. Vous pouvez ensuite remplacer chaque produit avant un nouveau rendu.';
  const composition=$('#new-composition-button');
  composition.querySelector('span').textContent='Proposer une autre composition';
  composition.querySelector('small').textContent='Local · gratuit';
  composition.nextElementSibling.textContent='Une autre composition tire de nouvelles références actives au hasard et conserve tous vos réglages.';
  $('#history-case-label').textContent='Rendus de ce projet';
  $('#history .eyebrow').textContent='MES CRÉATIONS';
  $('#history-all').closest('label').classList.add('hidden');
  $('#case-description').textContent='La photo reste privée. L’import ne lance aucun moteur d’image.';
  const technicalParagraphs=$$('.technical-details p');
  if(technicalParagraphs[0])technicalParagraphs[0].textContent='L’import et les réglages restent gratuits. Une nouvelle composition utilise un tirage aléatoire de références actives, modifiable avant le rendu. Votre forfait est vérifié seulement lorsque vous demandez la génération ; chaque clic autorise une seule image, sans relance automatique.';
}

function returnToPortal(view='overview') {
  const returnTo=`${location.pathname}${location.search}`;
  location.assign(`/portal.html?view=${encodeURIComponent(view)}&return_to=${encodeURIComponent(returnTo)}`);
}

function saveStudioDraft() {
  if(!state.projectId)return;
  const draft={saved_at:Date.now(),project_id:state.projectId,programme:state.programme,include_tv:state.includeTV,surfaces:state.surfaces,
    product_ids:state.selection.map(product=>product.catalog_id),selection_fingerprint:state.fingerprint,selection_origin:state.selectionOrigin,
    photo_path:state.photoPath,photo_asset_id:state.photoAssetId,photo_url:state.photoURL,photo_name:state.photoName,width:state.width,height:state.height};
  try {sessionStorage.setItem('aurimmo-studio-draft',JSON.stringify(draft));}catch{}
}

function restoreStudioDraft() {
  let draft;try{draft=JSON.parse(sessionStorage.getItem('aurimmo-studio-draft')||'null');}catch{return false;}
  if(!draft||draft.project_id!==state.projectId||Date.now()-Number(draft.saved_at)>24*60*60*1000)return false;
  const selection=Array.isArray(draft.product_ids)?draft.product_ids.map(id=>state.catalogue.find(product=>product.catalog_id===id)).filter(Boolean):[];
  if(selection.length!==draft.product_ids?.length)return false;
  state.programme=draft.programme||null;state.includeTV=Boolean(draft.include_tv);state.surfaces=draft.surfaces||{floor:'preserve',walls:'preserve'};
  state.selection=selection;state.fingerprint=draft.selection_fingerprint||null;state.selectionOrigin=draft.selection_origin||'edited';
  state.forcedByRole=Object.fromEntries(selection.map(product=>[product.role,product.catalog_id]));
  state.photoPath=draft.photo_path||null;state.photoAssetId=draft.photo_asset_id||null;state.photoURL=draft.photo_url||null;state.photoName=draft.photo_name||null;state.width=draft.width||null;state.height=draft.height||null;state.photoDeletable=Boolean(state.photoPath);
  if(state.photoName)$('#case-select').replaceChildren(new Option(state.photoName,state.photoName,true,true));
  if(state.photoURL)$('#original-thumbnail-image').src=state.photoURL;
  for(const input of $$('[data-surface]'))input.checked=input.value===state.surfaces[input.dataset.surface];
  return true;
}

async function ensureGenerationEntitlement() {
  const account=await api('/api/me');state.client=account;
  if(account.can_generate===true)return true;
  saveStudioDraft();
  const subscriptionStatus=account.subscription?.status;
  const existingSubscription=['active','past_due','unpaid','paused','incomplete','trialing'].includes(subscriptionStatus);
  setFeedback(existingSubscription?'Crédits indisponibles':'Choisissez votre formule',existingSubscription
    ?'Votre projet et vos réglages sont conservés. Consultez votre abonnement et le renouvellement de vos crédits avant de relancer.'
    :'Votre projet et vos réglages sont conservés. Sélectionnez Essentiel ou Pro avant de lancer le rendu.');
  returnToPortal(existingSubscription?'billing':'plans');return false;
}

function addSessionActions() {
  if($('#public-logout'))return;
  const actions=node('div','public-session-actions');
  const dashboard=node('a','text-button','← Mon espace');dashboard.href='/portal.html';
  const button=node('button','text-button','Se déconnecter');button.id='public-logout';button.type='button';
  button.addEventListener('click',async()=>{try{await api('/api/client-auth',{method:'DELETE'});}finally{returnToPortal('login');}});
  actions.append(dashboard,button);$('.page-shell').prepend(actions);
}

function renderProgrammes() {
  const container=$('#programme-cards');container.replaceChildren();
  for(const programme of PROGRAMMES) {
    const label=node('label',`programme-card${state.programme===programme.id?' selected':''}`);
    const radio=node('input');radio.type='radio';radio.name='requested-programme';radio.value=programme.id;radio.checked=state.programme===programme.id;
    const copy=node('span','programme-card-copy');copy.append(node('strong','',programme.title),node('span','programme-description',programme.description));
    label.append(radio,copy);
    if(programme.id==='living_dining'&&state.programme==='living_dining') {
      const option=node('span','programme-tv-option'),optionLabel=node('span','checkbox-label');
      const checkbox=node('input');checkbox.type='checkbox';checkbox.checked=state.includeTV;checkbox.setAttribute('aria-label','Ajouter une télévision générique au salon et espace repas');
      optionLabel.append(checkbox,node('span','', 'Ajouter une TV générique'));option.append(optionLabel);
      checkbox.addEventListener('click',event=>event.stopPropagation());
      checkbox.addEventListener('change',async()=>{state.includeTV=checkbox.checked;await refreshSelectionForSettings();renderProgrammes();renderCatalogueExplorer();});
      label.append(option);
    }
    radio.addEventListener('change',async()=>{
      state.programme=programme.id;state.includeTV=false;await prepareRandomSelection();renderProgrammes();renderCatalogueExplorer();
      $('#programme-message').textContent='Programme enregistré. Une sélection aléatoire active est prête gratuitement et reste modifiable.';
    });
    container.append(label);
  }
  $('#programme-summary').textContent=state.programme?`${programmeLabel()} · style Japandi · ${state.includeTV?'avec télévision générique':'sans télévision ajoutée'}.`:'Choisissez un aménagement avant de générer.';
}

function requiredRoles() {
  if(!state.programme)return [];
  const roles=[...PLANS[state.programme]];
  if(state.programme==='living_dining'&&state.includeTV)roles.push('tv_unit');
  if(state.surfaces.floor==='replace')roles.push('floor_finish');
  if(state.surfaces.walls==='replace')roles.push('wall_finish');
  return roles;
}

async function digest(value) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');
}

async function rebuildSelection({clearResults=true,randomize=false,avoidSelection=[]}={}) {
  if(!state.programme){state.selection=[];state.fingerprint=null;renderProducts();updateInterface();return;}
  state.selection=selectProductsByRole({catalogue:state.catalogue,roles:requiredRoles(),forcedByRole:state.forcedByRole,currentSelection:state.selection,avoidSelection,randomize});
  const canonical=JSON.stringify({program:state.programme,include_tv:Boolean(state.includeTV),surfaces:state.surfaces,
    products:state.selection.map(product=>({catalog_id:product.catalog_id,role:product.role,quantity:product.quantity}))});
  state.fingerprint=await digest(canonical);
  if(clearResults){state.results={};state.compare=false;state.view='original';}
  renderProducts();renderResults();updateInterface();
}

async function prepareRandomSelection() {
  const previous=[...state.selection];state.forcedByRole={};state.selectionOrigin='random';state.compositionVersion+=1;
  await rebuildSelection({randomize:true,avoidSelection:previous});
}

async function refreshSelectionForSettings() {
  state.selectionOrigin=Object.keys(state.forcedByRole).length?'edited':'random';state.compositionVersion+=1;
  await rebuildSelection();
}

function editProduct(product) {
  state.explorer.query='';state.explorer.role=product.role;state.explorer.page=0;
  $('#catalogue-query').value='';$('#catalogue-role').value=product.role;$('#catalogue-explorer-details').open=true;renderCatalogueExplorer();
  setFeedback('Choisissez une autre référence',`Le catalogue affiche les alternatives ${ROLE_LABELS[product.role]||product.role}. Le rendu existant et ses points restent inchangés dans le carnet.`);
  $('#catalogue-explorer-section').scrollIntoView({behavior:'smooth',block:'start'});
}

function productCard(product) {
  const article=node('article','product-card dynamic-product-card');
  const image=node('img','selected-product-image');image.src=product.image_url;image.alt=product.product_name;image.loading='lazy';image.referrerPolicy='no-referrer';
  const top=node('span','product-topline');top.append(node('span','',product.retailer),node('span','',`${ROLE_LABELS[product.role]||product.role} · qt. ${product.quantity}`));
  const name=node('h3','product-name',product.product_name);
  const description=node('p','product-description',product.dimensions||'Dimensions non certifiées dans le catalogue public.');
  const id=node('span','product-id',product.catalog_id);
  const bottom=node('div','product-bottomline'),price=node('strong','product-price',money(product));
  const link=node('a','product-link','Voir la fiche ↗');link.href=product.product_url;link.target='_blank';link.rel='noopener noreferrer';bottom.append(price,link);
  const inCart=state.cart.includes(product.catalog_id);
  const cart=node('button','button button-secondary public-product-cart-button',inCart?'Retirer du panier local':'Ajouter au panier local');cart.type='button';
  cart.addEventListener('click',()=>{
    state.cart=inCart?state.cart.filter(id=>id!==product.catalog_id):[...new Set([...state.cart,product.catalog_id])];
    persistCart();renderProducts();
  });
  const edit=node('button','text-button public-product-edit-button','Modifier ce produit');edit.type='button';edit.addEventListener('click',()=>editProduct(product));
  article.append(image,top,name,description,id,bottom,edit,cart);return article;
}

function renderProducts() {
  const container=$('#products');container.replaceChildren();
  if(!state.selection.length)container.append(node('div','catalogue-loading','Choisissez un aménagement pour préparer gratuitement les références.'));
  else for(const product of state.selection)container.append(productCard(product));
  $('#product-count').textContent=`${state.selection.length} référence${state.selection.length>1?'s':''}`;
  const origin=state.selectionOrigin==='history'?'Composition d’un rendu existant':state.selectionOrigin==='edited'?'Composition personnalisée':`Composition aléatoire n°${Math.max(1,state.compositionVersion)}`;
  $('#catalogue-intro').textContent=state.selection.length?`${origin} · ${state.selection.length} références figées pour ${programmeLabel().toLowerCase()}. Chaque produit peut être remplacé avant la génération.`:'Les produits apparaîtront après le choix de l’aménagement.';
  const finishes=state.selection.filter(product=>['floor_finish','wall_finish'].includes(product.role));
  const panel=$('#surface-plan-panel');panel.classList.toggle('hidden',!finishes.length);
  $('#surface-plan-details').replaceChildren(...finishes.map(product=>node('p','',`${ROLE_LABELS[product.role]} : ${product.product_name} · ${product.retailer}`)));
  $('#new-composition-button').disabled=!state.programme||state.busy;renderCart();
}

function renderCart() {
  const products=state.cart.map(id=>state.catalogue.find(product=>product.catalog_id===id)).filter(Boolean),items=$('#product-hotspot-cart-items');items.replaceChildren();
  if(!products.length)items.append(node('p','', 'Votre panier local est vide.'));
  for(const product of products) {
    const row=node('div','hotspot-cart-item'),image=node('img');image.src=product.image_url;image.alt='';
    const body=node('div');body.append(node('p','',product.product_name),node('p','',`${product.retailer} · ${money(product)}`));
    const remove=node('button','hotspot-cart-remove','Retirer');remove.type='button';remove.addEventListener('click',()=>{
      state.cart=state.cart.filter(id=>id!==product.catalog_id);persistCart();renderProducts();
    });
    row.append(image,body,remove);items.append(row);
  }
  $('#product-hotspot-cart').textContent=`Panier · ${products.length}`;
}

function searchable(value) {
  return String(value??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
}

function renderCatalogueExplorerOptions() {
  const select=$('#catalogue-role'),selected=state.explorer.role;select.replaceChildren(new Option('Tous les rôles gérés',''));
  const roles=state.catalogueRoles.length?state.catalogueRoles:[...new Set(state.catalogue.map(product=>product.role))].map(role=>({role,label:ROLE_LABELS[role]||role,eligible:state.catalogue.filter(product=>product.role===role).length}));
  for(const role of roles.filter(role=>role.eligible>0))select.append(new Option(`${role.label||ROLE_LABELS[role.role]||role.role} · ${role.eligible}`,role.role));
  select.value=selected;
}

async function chooseCatalogueProduct(product) {
  if(!requiredRoles().includes(product.role))return;
  state.forcedByRole[product.role]=product.catalog_id;
  state.selectionOrigin='edited';state.compositionVersion+=1;await rebuildSelection();renderCatalogueExplorer();
  $('#selection-preview-panel').open=true;
  setFeedback('Référence choisie',`${product.product_name} remplace la référence ${ROLE_LABELS[product.role]||product.role} de cette composition. Aucun appel IA n’a été lancé.`);
  $('#catalogue').scrollIntoView({behavior:'smooth',block:'start'});
}

function explorerCard(product) {
  const article=node('article','catalogue-explorer-card'),image=node('img','catalogue-explorer-image');
  image.src=product.image_url;image.alt=product.product_name;image.loading='lazy';image.referrerPolicy='no-referrer';
  article.append(image,node('span','product-topline',`${product.retailer} · ${ROLE_LABELS[product.role]||product.role}`),node('h3','',product.product_name),node('span','product-id',product.catalog_id),node('strong','',money(product)));
  const link=node('a','product-link','Voir la fiche ↗');link.href=product.product_url;link.target='_blank';link.rel='noopener noreferrer';article.append(link);
  const historical=product.selection_status==='historical_run_only',usable=!historical&&requiredRoles().includes(product.role),selected=state.selection.some(item=>item.catalog_id===product.catalog_id);
  const button=node('button','text-button',selected?'Sélectionnée pour ce rendu':historical?'Référence conservée pour un ancien rendu':usable?'Choisir cette référence':'Rôle hors du programme choisi');button.type='button';button.disabled=!usable||selected;button.setAttribute('aria-pressed',String(selected));
  button.addEventListener('click',()=>chooseCatalogueProduct(product));article.append(button);return article;
}

function renderCatalogueExplorer() {
  const section=$('#catalogue-explorer-section');section.classList.remove('hidden');
  $('#catalogue-explorer-title').textContent=`Explorer les ${state.catalogueActiveTotal.toLocaleString('fr-FR')} références actives Salon / Japandi`;
  $('#explorer-summary').textContent=state.catalogue.length?`${state.catalogueActiveTotal.toLocaleString('fr-FR')} références actives consultables${state.catalogueHistoricalTotal?` + ${state.catalogueHistoricalTotal} références conservées uniquement pour les anciens rendus`:''}. La recherche et le changement d’une référence active sont locaux et gratuits.`:'Chargement du catalogue…';
  if(!$('#catalogue-explorer-details').open)return;
  const query=searchable(state.explorer.query),role=state.explorer.role;
  const filtered=state.catalogue.filter(product=>(!role||product.role===role)&&(!query||searchable([product.catalog_id,product.sku,product.retailer,product.product_name,product.category].join(' ')).includes(query)));
  const pageCount=Math.max(1,Math.ceil(filtered.length/state.explorer.limit));state.explorer.page=Math.min(state.explorer.page,pageCount-1);
  const start=state.explorer.page*state.explorer.limit,shown=filtered.slice(start,start+state.explorer.limit),container=$('#catalogue-explorer-products');container.replaceChildren(...shown.map(explorerCard));
  if(!shown.length)container.append(node('p','field-note','Aucune référence ne correspond à cette recherche.'));
  $('#catalogue-explorer-feedback').textContent=`${filtered.length.toLocaleString('fr-FR')} résultat${filtered.length>1?'s':''} · ${shown.length?`${start+1}–${start+shown.length}`:'aucun affiché'}.`;
  $('#catalogue-page-status').textContent=`Page ${state.explorer.page+1} / ${pageCount}`;
  $('#catalogue-page-previous').disabled=state.explorer.page===0;$('#catalogue-page-next').disabled=state.explorer.page>=pageCount-1;
}

function renderSurfaceMessage() {
  const floor=state.surfaces.floor==='preserve'?'sol conservé':'sol modifié avec une finition catalogue';
  const walls=state.surfaces.walls==='preserve'?'murs conservés':'murs modifiés avec une finition catalogue';
  $('#surface-message').textContent=`${floor[0].toUpperCase()+floor.slice(1)} et ${walls}. Ces deux choix sont indépendants.`;
  for(const input of $$('[data-surface]'))input.closest('.surface-card').classList.toggle('selected',input.checked);
}

function renderEngine() {
  $('#image-key-label').textContent=`${providerLabel()} actif`;$('#provider-progress-label').textContent=`Rendu ${providerLabel()}`;
  $('#render-cost-label').textContent=`Rendu ${providerLabel()}`;$('#model-name').textContent=providerLabel();
}

function markReady(iconSelector,statusSelector,label,ready=true) {
  const icon=$(iconSelector),status=$(statusSelector);icon.className=`check-icon${ready?'':' blocked'}`;icon.textContent=ready?'✓':'!';
  status.textContent=label;status.classList.toggle('blocked',!ready);
}

function updateReadiness() {
  const providerConfigured=Boolean(state.providers[state.provider]?.configured)&&state.generationEnabled,configured=providerConfigured&&state.hotspotWorkerReady;
  const selectionLabel=state.selectionOrigin==='edited'?'Personnalisée':state.selectionOrigin==='history'?'Historique figé':state.selection.length?'Aléatoire figée':'En attente';
  markReady('#key-icon','#key-status',selectionLabel,Boolean(state.selection.length));
  markReady('#flux-key-icon','#flux-key-status',configured?'Prêt':providerConfigured?'Points non configurés':'Non configuré',configured);
  markReady('#integrity-icon','#integrity-status',state.photoPath?'Photo privée prête':'Photo attendue',Boolean(state.photoPath));
  markReady('#catalogue-icon','#catalogue-status',state.catalogueActiveTotal?`${state.catalogueActiveTotal.toLocaleString('fr-FR')} actives`:'Indisponible',Boolean(state.catalogueActiveTotal));
  const fullyReady=configured&&state.photoPath&&Number.isInteger(state.width)&&Number.isInteger(state.height)&&state.programme&&state.fingerprint;
  const pill=$('#readiness-pill');pill.className=`readiness-pill${fullyReady?'':' loading'}`;pill.textContent=fullyReady?'Prêt à générer':'Préparation';
  $('#config-help').classList.toggle('hidden',configured);
}

function resultMatchesDraft(result) {
  return Boolean(result&&result.selection_fingerprint===state.fingerprint&&result.source_path===state.photoPath);
}

function updateGenerate() {
  const button=$('#dynamic-generate-button'),label=button.querySelector('span'),providerConfigured=Boolean(state.providers[state.provider]?.configured)&&state.generationEnabled,configured=providerConfigured&&state.hotspotWorkerReady;
  const previous=resultMatchesDraft(state.results[state.provider]);let text=`Générer avec ${providerLabel()}`;
  if(!state.photoPath)text='Prendre ou télécharger une photo';else if(!state.programme)text='Choisir un aménagement';
  else if(!providerConfigured)text=`${providerLabel()} non configuré`;else if(!state.hotspotWorkerReady)text='Points non configurés';else if(previous)text=`Rendu ${providerLabel()} obtenu`;
  const dimensionsReady=Number.isInteger(state.width)&&Number.isInteger(state.height);
  label.textContent=text;button.disabled=state.busy||!state.photoPath||!dimensionsReady||!state.programme||!state.fingerprint||!configured||previous;
  const replay=$('#replay-render-button');replay.classList.toggle('hidden',!previous||!state.photoPath);replay.disabled=state.busy||!configured||!previous||!state.photoPath;
  const stage=$('#dynamic-stage');
  if(state.busy)stage.textContent=`${providerLabel()} génère l’image. Aucun retry automatique.`;
  else if(!state.photoPath)stage.textContent='Prenez une photo ou téléchargez une image pour commencer. L’import est gratuit.';
  else if(!state.programme)stage.textContent='Choisissez un aménagement avant de générer.';
  else if(!providerConfigured)stage.textContent=`${providerLabel()} n’est pas configuré sur le serveur.`;
  else if(!state.hotspotWorkerReady)stage.textContent='La génération est bloquée tant que le worker de points produits n’est pas prêt.';
  else if(previous)stage.textContent=`Le rendu ${providerLabel()} est disponible. Vous pouvez préparer une autre composition.`;
  else stage.textContent='Prêt. Votre forfait sera vérifié avant d’autoriser un seul rendu Muse, sans relance automatique.';
}

function updateInterface() { renderEngine();renderSurfaceMessage();updateReadiness();updateGenerate();renderCart(); }

function currentResult() {
  const exact=state.results[state.provider];if(resultMatchesDraft(exact))return exact;
  return Object.values(state.results).find(result=>resultMatchesDraft(result))||null;
}

function setStageImage(url,{href=url,badge,caption,dimensions,alt}) {
  const image=$('#stage-image'),link=$('#stage-link');image.src=url;image.alt=alt||'';link.href=href||url;
  link.setAttribute('aria-label',alt?`Ouvrir en grand : ${alt}`:'Ouvrir l’image en grand');
  $('#stage-badge').textContent=badge;$('#stage-caption').textContent=caption;$('#stage-dimensions').textContent=dimensions||'';
}

function setView(view) {
  if(view==='result'&&!currentResult())view='original';state.view=view;state.compare=false;
  $('#image-stage').classList.remove('comparing');$('#stage-link').classList.remove('hidden');
  if(view==='original')setStageImage(state.photoURL||'/placeholder-room.svg',{badge:'PHOTO ORIGINALE',caption:state.photoPath?'Architecture, ouvertures, sol et installations fixes à conserver.':'Prenez ou ajoutez la photographie du salon.',dimensions:state.width?`${state.width.toLocaleString('fr-FR')} × ${state.height.toLocaleString('fr-FR')}`:'',alt:state.photoPath?'Photographie originale du salon':'Ajoutez ou prenez une photographie de votre salon'});
  else {
    const result=currentResult();setStageImage(result.image_url,{badge:`RENDU ${providerLabel(result.provider).toUpperCase()}`,caption:'Rendu à examiner : architecture, installations fixes et produits restent à valider humainement.',dimensions:`${Math.round(result.elapsed_ms/1000)} s`,alt:`Rendu Japandi généré par ${providerLabel(result.provider)}`});
  }
  for(const tab of $$('.view-tab')){const active=tab.dataset.view===view;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));}
  for(const item of $$('.comparison-item'))item.classList.toggle('active',item.dataset.view===view);
  $('#stage-empty').classList.add('hidden');updateHotspotNotice();
}

function closeHotspotCard() {
  const card=$('#product-hotspot-card');card.classList.add('hidden');card.replaceChildren();
  for(const button of $$('#product-hotspot-layer .product-hotspot-point'))button.setAttribute('aria-expanded','false');
}

function containedImageRect() {
  const stage=$('#image-stage'),image=$('#stage-image'),stageRect=stage.getBoundingClientRect(),imageRect=image.getBoundingClientRect();
  if(!image.complete||!image.naturalWidth||!image.naturalHeight||!imageRect.width||!imageRect.height)return null;
  const scale=Math.min(imageRect.width/image.naturalWidth,imageRect.height/image.naturalHeight),width=image.naturalWidth*scale,height=image.naturalHeight*scale;
  return {left:imageRect.left-stageRect.left+(imageRect.width-width)/2,top:imageRect.top-stageRect.top+(imageRect.height-height)/2,width,height};
}

function openHotspotCard(point,payload,button) {
  const product=payload.products.find(item=>item.catalog_id===point.catalog_id);if(!product)return;
  closeHotspotCard();button.setAttribute('aria-expanded','true');
  const card=$('#product-hotspot-card'),title=node('h3','visually-hidden',product.product_name);title.id='product-hotspot-card-title';
  const close=node('button','hotspot-card-close','×');close.type='button';close.setAttribute('aria-label','Fermer la fiche produit');close.addEventListener('click',closeHotspotCard);
  const photo=node('img','hotspot-card-photo');photo.src=product.image_url;photo.alt=product.product_name;photo.referrerPolicy='no-referrer';
  const body=node('div','hotspot-card-body');body.append(node('span','hotspot-card-retailer',product.retailer),node('p','hotspot-card-name',product.product_name),node('strong','hotspot-card-price',money(product)));
  const link=node('a','product-link','Voir la fiche ↗');link.href=product.product_url;link.target='_blank';link.rel='noopener noreferrer';body.append(link);
  const inCart=state.cart.includes(product.catalog_id),add=node('button','hotspot-card-add',inCart?'Retirer du panier local':'Ajouter au panier local');add.type='button';
  add.addEventListener('click',()=>{state.cart=inCart?state.cart.filter(id=>id!==product.catalog_id):[...new Set([...state.cart,product.catalog_id])];persistCart();renderCart();closeHotspotCard();});
  const edit=node('button','text-button public-product-edit-button','Modifier ce produit');edit.type='button';edit.addEventListener('click',()=>{closeHotspotCard();editProduct(product);});
  body.append(edit,add);card.append(title,close,photo,body);card.classList.remove('hidden');
  const rect=containedImageRect(),stage=$('#image-stage').getBoundingClientRect(),dimensions=card.getBoundingClientRect();if(!rect)return;
  const x=rect.left+rect.width*point.x,y=rect.top+rect.height*point.y,placeRight=x+dimensions.width+32<stage.width;
  const left=Math.min(Math.max(10,placeRight?x+22:x-dimensions.width-22),Math.max(10,stage.width-dimensions.width-10));
  const top=Math.min(Math.max(10,y-dimensions.height/2),Math.max(10,stage.height-dimensions.height-10));
  card.dataset.tailSide=placeRight?'left':'right';Object.assign(card.style,{left:`${left}px`,top:`${top}px`,'--hotspot-tail-y':`${Math.min(dimensions.height-18,Math.max(18,y-top))}px`});close.focus();
}

function renderHotspots() {
  const layer=$('#product-hotspot-layer'),result=currentResult(),payload=result&&state.hotspots.get(result.run_id);layer.replaceChildren();closeHotspotCard();
  const active=state.view==='result'&&!state.compare&&result&&payload?.localization?.status==='completed'&&state.hotspotVisible&&payload.hotspots.length;
  if(!active){layer.classList.add('hidden');return;}
  const rect=containedImageRect();if(!rect){layer.classList.add('hidden');return;}
  Object.assign(layer.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  for(const point of payload.hotspots) {
    const product=payload.products.find(item=>item.catalog_id===point.catalog_id);if(!product)continue;
    const button=node('button','product-hotspot-point');button.type='button';button.style.left=`${point.x*100}%`;button.style.top=`${point.y*100}%`;
    button.setAttribute('aria-label',`Voir le produit : ${product.product_name}`);button.setAttribute('aria-expanded','false');button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();openHotspotCard(point,payload,button);});layer.append(button);
  }
  layer.classList.remove('hidden');
}

function clearHotspotPolling() {
  if(state.hotspotTimer!==null){clearTimeout(state.hotspotTimer);state.hotspotTimer=null;}state.hotspotPollingRun=null;
}

function ensureHotspots(result) {
  if(!result?.run_id||state.hotspotPollingRun===result.run_id)return;
  clearHotspotPolling();state.hotspotPollingRun=result.run_id;
  const poll=async attempt=>{
    try {
      const payload=await api(`/api/hotspots?run_id=${encodeURIComponent(result.run_id)}`);state.hotspots.set(result.run_id,payload);updateHotspotNotice();
      const localization=payload.localization||{},active=['queued','pending','processing'].includes(localization.status)||localization.status==='failed'&&localization.retryable!==false;
      if(active&&attempt<720&&currentResult()?.run_id===result.run_id)state.hotspotTimer=setTimeout(()=>poll(attempt+1),7000);
      else state.hotspotPollingRun=null;
    } catch(error) {
      state.hotspots.set(result.run_id,{run_id:result.run_id,products:result.products||[],hotspots:[],localization:{status:'failed'},error:error.message});state.hotspotPollingRun=null;updateHotspotNotice();
    }
  };
  poll(0);
}

function updateHotspotNotice() {
  const result=currentResult(),visible=state.view==='result'&&!state.compare&&Boolean(result),tools=$('#product-hotspot-tools'),status=$('#product-hotspot-status'),payload=result&&state.hotspots.get(result.run_id),toggle=$('#product-hotspot-toggle');
  tools.classList.toggle('hidden',!visible);status.classList.toggle('hidden',!visible);
  toggle.textContent=state.hotspotVisible?'Masquer les points':'Afficher les points';toggle.setAttribute('aria-pressed',String(state.hotspotVisible));toggle.disabled=!payload?.hotspots?.length;
  status.classList.toggle('error',payload?.localization?.status==='failed');
  if(!visible)status.textContent='';
  else if(!payload||['queued','pending'].includes(payload.localization?.status))status.textContent='Rendu placé dans la file de repérage · vision hors ligne hébergée, sans nouvel appel de génération.';
  else if(payload.localization?.status==='processing')status.textContent=`Repérage automatique en cours sur l’image finale${payload.localization.attempt?` · tentative locale ${payload.localization.attempt}`:''}.`;
  else if(payload.localization?.status==='failed'&&payload.localization?.retryable!==false)status.textContent='Le worker a rencontré un incident ; une nouvelle tentative de repérage local est programmée. Le rendu payé reste intact.';
  else if(payload.localization?.status==='failed')status.textContent='Le repérage des produits a échoué ; le rendu reste intact et aucun point approximatif n’a été ajouté.';
  else if(payload.hotspots.length)status.textContent=`${payload.hotspots.length} produit${payload.hotspots.length>1?'s':''} localisé${payload.hotspots.length>1?'s':''} sur ${payload.products.length} · cliquez sur un rond bleu pour voir la référence exacte.`;
  else status.textContent='Aucun produit n’a été localisé avec assez de confiance ; aucun point inventé n’a été ajouté.';
  renderHotspots();if(visible&&!payload)ensureHotspots(result);
}

function renderResults() {
  const result=currentResult(),thumbnail=$('#result-thumbnail-image'),empty=$('#result-thumbnail .thumbnail-empty');
  $('#tab-result').disabled=!result;$('#tab-result').tabIndex=result?0:-1;$('#result-dot').classList.toggle('hidden',!result);
  if(result){thumbnail.src=result.image_url;thumbnail.classList.remove('hidden');empty.classList.add('hidden');}
  else {thumbnail.removeAttribute('src');thumbnail.classList.add('hidden');empty.classList.remove('hidden');}
  if(state.view==='result')setView('result');else setView('original');
}

function renderHistory() {
  const container=$('#history-content');container.replaceChildren();
  if(!state.history.length){
    const empty=node('div','history-empty');empty.append(node('span','history-number','01'));
    const text=node('div');text.append(node('h3','', 'Aucun rendu pour ce projet'),node('p','', 'Chaque création apparaîtra ici avec sa sélection catalogue figée.'));
    empty.append(text);container.append(empty);return;
  }
  const newestFirst=[...state.history].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  for(const result of newestFirst) {
    const row=node('article','history-row'),image=node('img');image.src=result.image_url;image.alt=`Rendu ${providerLabel(result.provider)}`;
    const copy=node('div'),title=node('h3','',`${providerLabel(result.provider)} · ${programmeLabel(result.program)}`),status=node('span','history-state pending','Revue humaine');title.append(status);
    copy.append(title,node('p','history-meta',`${new Date(result.created_at).toLocaleString('fr-FR')} · ${result.products.length} références · ${Math.round(result.elapsed_ms/1000)} s · ${costLabel(result)}`));
    const actions=node('div','history-actions'),open=node('button','text-button','Ouvrir avec les points');open.type='button';open.addEventListener('click',()=>openHistoryResult(result).catch(error=>setFeedback('Rendu indisponible',error.message,{error:true})));
    const link=node('a','', 'Image ↗');link.href=result.image_url;link.target='_blank';link.rel='noopener';actions.append(open,link);row.append(image,copy,actions);container.append(row);
  }
}

async function imageDimensions(url) {
  return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('La photo source privée ne peut pas être relue.'));image.src=url;});
}

async function openHistoryResult(result) {
  const token=++state.historyOpenToken;let dimensions={width:null,height:null};
  if(result.source_image_url)try{dimensions=await imageDimensions(result.source_image_url);}catch{}
  if(token!==state.historyOpenToken)return;
  clearHotspotPolling();state.provider='muse';state.programme=result.program;state.includeTV=Boolean(result.include_tv);state.surfaces=result.surfaces||{floor:'preserve',walls:'preserve'};
  state.selection=result.products;state.fingerprint=result.selection_fingerprint;state.forcedByRole=Object.fromEntries(result.products.map(product=>[product.role,product.catalog_id]));
  state.selectionOrigin='history';state.compositionVersion+=1;state.photoPath=result.source_path||null;state.photoAssetId=result.source_asset_id||null;state.photoURL=result.source_image_url||null;state.photoName=`Photo du rendu ${result.run_id}`;state.photoDeletable=false;
  Object.assign(state,dimensions);
  state.results={muse:result};state.view='result';state.compare=false;
  for(const input of $$('[data-surface]'))input.checked=input.value===state.surfaces[input.dataset.surface];
  $('#case-select').replaceChildren(new Option(state.photoName,state.photoName,true,true));$('#delete-photo-button').disabled=true;
  if(state.photoURL)$('#original-thumbnail-image').src=state.photoURL;
  renderProgrammes();renderProducts();renderCatalogueExplorer();renderResults();updateInterface();setView('result');ensureHotspots(result);$('#workspace').scrollIntoView({behavior:'smooth',block:'start'});
}

async function refreshHistory() {
  const query=state.projectId?`?project_id=${encodeURIComponent(state.projectId)}`:'';
  const payload=await api(`/api/history${query}`);state.history=payload.runs||[];renderHistory();
  const result=currentResult(),fresh=result&&state.history.find(item=>item.run_id===result.run_id);
  if(fresh){state.results[fresh.provider]=fresh;renderResults();}
}

async function optimizePhoto(file) {
  const bitmap=await createImageBitmap(file),max=1800,ratio=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  let width=Math.max(320,Math.round(bitmap.width*ratio)),height=Math.max(320,Math.round(bitmap.height*ratio)),quality=.86,blob=null;
  for(let attempt=0;attempt<5;attempt++) {
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{alpha:false});context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(bitmap,0,0,width,height);
    blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
    if(blob&&blob.size<=3_500_000)break;
    width=Math.max(320,Math.round(width*.82));height=Math.max(320,Math.round(height*.82));quality=Math.max(.68,quality-.05);
  }
  bitmap.close();if(!blob||blob.size>3_500_000)throw new Error('Cette photo ne peut pas être optimisée sous la limite de stockage.');return {blob,width,height};
}

async function uploadPhoto(file) {
  if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw new Error('Choisissez une photo JPEG, PNG ou WebP.');
  $('#case-feedback').classList.remove('hidden');$('#case-feedback').textContent='Optimisation locale de la photo…';
  const optimized=await optimizePhoto(file);state.historyOpenToken+=1;$('#case-feedback').textContent='Envoi vers le stockage privé…';
  // Vercel exposes application/octet-stream uploads as an authoritative Buffer.
  // Keep the verified image MIME in a dedicated same-origin header so the API
  // can compare it with the file signature before persisting anything.
  const uploaded=await api('/api/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Aurimmo-Source-Content-Type':optimized.blob.type,'X-Aurimmo-Project-Id':state.projectId},body:optimized.blob});
  const verifiedWidth=Number(uploaded.width)||optimized.width,verifiedHeight=Number(uploaded.height)||optimized.height;
  if(state.photoURL?.startsWith('blob:'))URL.revokeObjectURL(state.photoURL);
  state.photoURL=uploaded.image_url||URL.createObjectURL(optimized.blob);state.photoPath=uploaded.pathname;state.photoAssetId=uploaded.asset_id||null;state.photoName=file.name;state.width=verifiedWidth;state.height=verifiedHeight;state.photoDeletable=true;
  state.results={};state.compare=false;state.view='original';
  const select=$('#case-select');select.replaceChildren(new Option(file.name,file.name,true,true));
  $('#delete-photo-button').disabled=false;$('#case-feedback').textContent=`Photo privée prête · ${verifiedWidth} × ${verifiedHeight} · ${(optimized.blob.size/1024/1024).toFixed(2)} Mo. Aucun appel IA effectué.`;
  $('#original-thumbnail-image').src=state.photoURL;if(state.programme)await prepareRandomSelection();setView('original');renderResults();updateInterface();
}

async function deletePhoto() {
  if(!state.photoPath||!state.photoDeletable)return;
  $('#delete-photo-button').disabled=true;$('#case-feedback').classList.remove('hidden');$('#case-feedback').textContent='Suppression de la photo privée…';
  try {
    await api('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths:[state.photoPath]})});
    if(state.photoURL?.startsWith('blob:'))URL.revokeObjectURL(state.photoURL);
    Object.assign(state,{photoPath:null,photoAssetId:null,photoURL:null,photoName:null,width:null,height:null,photoDeletable:false,results:{},compare:false,view:'original'});
    $('#camera-file').value='';$('#room-file').value='';$('#case-select').replaceChildren(new Option('Aucune photo ajoutée','',true,true));
    $('#original-thumbnail-image').src='/placeholder-room.svg';$('#case-feedback').textContent='Photo supprimée du stockage privé.';
    renderResults();updateInterface();
  } catch(error) { $('#case-feedback').textContent=error.message;$('#delete-photo-button').disabled=false; }
}

function setProgress(active=false,failed=false) {
  const progress=$('#automatic-progress');progress.classList.toggle('hidden',!active&&!failed);
  for(const item of $$('[data-generation-phase]'))item.className=failed&&item.dataset.generationPhase==='rendering'?'failed':active&&item.dataset.generationPhase==='rendering'?'current':'done';
}

async function generate({fresh=false}={}) {
  if(state.busy)return;state.busy=true;
  let authorizationId=null;
  try {
    if(fresh)await prepareRandomSelection();
    const existing=resultMatchesDraft(state.results[state.provider]);
    if(!state.photoPath||!state.fingerprint||existing)return;
    if(!await ensureGenerationEntitlement())return;
    authorizationId=generationAuthorization();
    setProgress(true);updateInterface();setFeedback('Génération en cours',`${providerLabel()} reçoit la photo et les ${state.selection.length} références exactes. Un seul appel, sans retry.`,{busy:true});
    const result=await api('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      project_id:state.projectId,source_asset_id:state.photoAssetId,provider:'muse',program:state.programme,include_tv:state.includeTV,surfaces:state.surfaces,room_path:state.photoPath,width:state.width,height:state.height,
      product_ids:state.selection.map(product=>product.catalog_id),selection_fingerprint:state.fingerprint,authorization_id:authorizationId,confirm_paid_generation:true,
    })});
    clearGenerationAuthorization(authorizationId);
    const complete={...result,program:state.programme,include_tv:state.includeTV,surfaces:{...state.surfaces},source_path:state.photoPath,source_image_url:state.photoURL,created_at:new Date().toISOString()};
    state.results[state.provider]=complete;state.history.push(complete);state.view='result';state.compare=false;state.photoDeletable=false;$('#delete-photo-button').disabled=true;
    $('#render-cost').textContent=costLabel(complete);renderHistory();renderResults();setView('result');ensureHotspots(complete);
    setFeedback('Rendu reçu',`${providerLabel()} a livré une image. Le repérage des ronds bleus démarre sur les pixels finaux ; vérifiez aussi le poêle, l’architecture, les ouvertures, les fixes et chaque produit.`);
    $('#workspace').scrollIntoView({behavior:'smooth',block:'start'});
  } catch(error) {
    setProgress(false,true);
    if(error.payload?.authorization_reusable===false)clearGenerationAuthorization(authorizationId);
    if(error.status===402){saveStudioDraft();returnToPortal('plans');return;}
    setFeedback('Génération arrêtée',error.message,{error:true});
  }
  finally {state.busy=false;setProgress(false);updateInterface();}
}

function bindEvents() {
  $('#camera-button').addEventListener('click',()=>$('#camera-file').click());
  $('#upload-button').addEventListener('click',()=>$('#room-file').click());
  for(const input of [$('#camera-file'),$('#room-file')])input.addEventListener('change',async event=>{
    const file=event.currentTarget.files?.[0];if(!file)return;
    try{await uploadPhoto(file);}catch(error){$('#case-feedback').classList.remove('hidden');$('#case-feedback').textContent=error.message;}
    finally{event.currentTarget.value='';}
  });
  $('#delete-photo-button').addEventListener('click',deletePhoto);
  for(const input of $$('[data-surface]'))input.addEventListener('change',async()=>{
    state.surfaces={floor:$('input[name="surface-floor"]:checked').value,walls:$('input[name="surface-walls"]:checked').value};
    await refreshSelectionForSettings();renderSurfaceMessage();renderCatalogueExplorer();
  });
  $('#new-composition-button').addEventListener('click',async()=>{
    await prepareRandomSelection();renderCatalogueExplorer();$('#selection-preview-panel').open=true;
    setFeedback('Nouvelle composition aléatoire prête','Chaque rôle utilise une nouvelle référence active lorsque le catalogue offre une alternative. Aucun moteur d’image et aucun appel payant n’ont été lancés.');$('#catalogue').scrollIntoView({behavior:'smooth',block:'start'});
  });
  $('#dynamic-generate-button').addEventListener('click',()=>generate());$('#replay-render-button').addEventListener('click',()=>generate({fresh:true}));
  $('#tab-original').addEventListener('click',()=>setView('original'));$('#tab-result').addEventListener('click',()=>setView('result'));
  for(const item of $$('.comparison-item'))item.addEventListener('click',()=>setView(item.dataset.view));
  $('#product-hotspot-toggle').addEventListener('click',()=>{state.hotspotVisible=!state.hotspotVisible;updateHotspotNotice();});
  $('#product-hotspot-refresh').addEventListener('click',async()=>{
    const result=currentResult();if(!result)return;const button=$('#product-hotspot-refresh');button.disabled=true;
    try {await api('/api/hotspots-retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({run_id:result.run_id})});state.hotspots.delete(result.run_id);clearHotspotPolling();ensureHotspots(result);}
    catch(error){setFeedback('Repérage non relancé',error.message,{error:true});}
    finally{button.disabled=false;}
  });
  $('#product-hotspot-cart').addEventListener('click',()=>{
    const panel=$('#product-hotspot-cart-panel'),opening=panel.classList.contains('hidden');panel.classList.toggle('hidden',!opening);$('#product-hotspot-cart').setAttribute('aria-expanded',String(opening));
  });
  $('#product-hotspot-cart-close').addEventListener('click',()=>{$('#product-hotspot-cart-panel').classList.add('hidden');$('#product-hotspot-cart').setAttribute('aria-expanded','false');});
  $('#image-stage').addEventListener('click',event=>{if(!event.target.closest('.product-hotspot-point')&&!event.target.closest('#product-hotspot-card'))closeHotspotCard();});
  $('#stage-image').addEventListener('load',renderHotspots);window.addEventListener('resize',renderHotspots);
  $('#catalogue-explorer-details').addEventListener('toggle',renderCatalogueExplorer);
  $('#catalogue-search-form').addEventListener('submit',event=>{event.preventDefault();state.explorer.query=$('#catalogue-query').value.trim();state.explorer.role=$('#catalogue-role').value;state.explorer.page=0;renderCatalogueExplorer();});
  $('#catalogue-role').addEventListener('change',()=>{state.explorer.role=$('#catalogue-role').value;state.explorer.page=0;renderCatalogueExplorer();});
  $('#catalogue-page-previous').addEventListener('click',()=>{state.explorer.page=Math.max(0,state.explorer.page-1);renderCatalogueExplorer();$('#catalogue-explorer-section').scrollIntoView({behavior:'smooth',block:'start'});});
  $('#catalogue-page-next').addEventListener('click',()=>{state.explorer.page+=1;renderCatalogueExplorer();$('#catalogue-explorer-section').scrollIntoView({behavior:'smooth',block:'start'});});
  $('#refresh-button').addEventListener('click',()=>refreshHistory().catch(error=>setFeedback('Historique indisponible',error.message,{error:true})));
}

async function initialize() {
  if(state.initialized)return;state.initialized=true;addSessionActions();
  try {
    const account=state.client||await api('/api/me'),requestedProject=new URLSearchParams(location.search).get('project');
    state.client=account;
    const projects=Array.isArray(account.projects)?account.projects:[];
    const project=projects.find(item=>item.id===requestedProject)||projects[0];
    if(!project?.id){returnToPortal('onboarding');return;}
    state.projectId=project.id;state.cart=savedCart();
    const [catalogue,status,history]=await Promise.all([api('/api/catalogue'),api('/api/status'),api(`/api/history?project_id=${encodeURIComponent(state.projectId)}`)]);
    state.catalogue=catalogue.products;state.catalogueRoles=catalogue.roles||[];state.catalogueActiveTotal=catalogue.active_total??catalogue.products.length;state.catalogueHistoricalTotal=catalogue.historical_run_only_total??0;state.providers=status.providers||{};state.generationEnabled=status.generation_enabled===true;state.hotspotWorkerReady=status.hotspots?.configured===true;state.history=history.runs||[];
    $('#camera-button').disabled=false;$('#upload-button').disabled=false;$('#authentication-status').textContent=`Compte client actif · ${project.name||'Projet'}`;$('#case-select').replaceChildren(new Option('Aucune photo ajoutée','',true,true));
    restoreStudioDraft();
    renderCatalogueExplorerOptions();renderCatalogueExplorer();renderProgrammes();renderProducts();renderHistory();updateInterface();
  } catch(error) {
    state.initialized=false;$('#connection-banner').textContent=error.message;$('#connection-banner').classList.remove('hidden');throw error;
  }
}

async function boot() {
  hideUnsupportedControls();bindEvents();renderProgrammes();renderProducts();renderHistory();renderSurfaceMessage();setView('original');
  try {
    const auth=await api('/api/client-auth');
    if(!auth.authenticated){returnToPortal('login');return;}
    state.client=await api('/api/me');await initialize();
  } catch(error) {
    if(error.status===401){returnToPortal('login');return;}
    $('#connection-banner').textContent=error.message;$('#connection-banner').classList.remove('hidden');
  }
}

boot();
