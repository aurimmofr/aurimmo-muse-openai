const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const state={catalogue:[],provider:'openai',programme:'living_conversation',includeTV:false,surfaces:{floor:'preserve',walls:'preserve'},variant:0,selection:[],fingerprint:null,
  photoPath:null,photoURL:null,photoName:null,width:null,height:null,providers:{},results:{},compare:false,cart:JSON.parse(localStorage.getItem('aurimmo-cart')||'[]')};

const roleLabels={sofa:'Canapé',armchair:'Fauteuil',coffee_table:'Table basse',rug:'Tapis',floor_lamp:'Lampadaire',artwork:'Décoration murale',decorative_object:'Objet décoratif',side_table:'Table d’appoint',bookcase:'Bibliothèque',table_lamp:'Lampe à poser',tv_unit:'Meuble TV',dining_table:'Table de repas',dining_chair:'Chaise de repas',pendant:'Suspension',floor_finish:'Finition du sol',wall_finish:'Finition murale'};
const plans={
  living_conversation:['sofa','armchair','coffee_table','rug','floor_lamp','decorative_object'],
  living_reading:['armchair','side_table','floor_lamp','rug','bookcase','table_lamp'],
  living_tv:['sofa','armchair','coffee_table','rug','floor_lamp','tv_unit'],
  living_dining:['sofa','coffee_table','rug','dining_table','dining_chair','pendant']
};

async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',...options});
  let payload;try{payload=await response.json();}catch{payload={error:'Réponse serveur illisible.'};}
  if(!response.ok)throw Object.assign(new Error(payload.error||'Action impossible.'),{payload,status:response.status});
  return payload;
}

function setMessage(text,type=''){$('#message').textContent=text;$('#message').className=`message ${type}`;}
function money(product){return product.price==null?'Prix non certifié':new Intl.NumberFormat('fr-FR',{style:'currency',currency:product.currency||'EUR'}).format(product.price);}
function saveCart(){localStorage.setItem('aurimmo-cart',JSON.stringify(state.cart));renderCart();}

function card(product,{cart=true}={}){
  const article=document.createElement('article');article.className='product-card';
  const image=document.createElement('img');image.src=product.image_url;image.alt=product.product_name;image.loading='lazy';article.append(image);
  const info=document.createElement('div');info.className='product-info';
  const label=document.createElement('small');label.textContent=`${roleLabels[product.role]||product.role} · quantité ${product.quantity}`;
  const title=document.createElement('strong');title.textContent=product.product_name;
  const meta=document.createElement('div');meta.className='product-meta';meta.innerHTML=`<span>${product.retailer}</span><span>${money(product)}</span>`;
  info.append(label,title,meta);
  if(cart){const button=document.createElement('button');button.className='secondary';button.textContent=state.cart.includes(product.catalog_id)?'Retirer du panier':'Ajouter au panier · Local';button.onclick=()=>{state.cart=state.cart.includes(product.catalog_id)?state.cart.filter(id=>id!==product.catalog_id):[...state.cart,product.catalog_id];saveCart();renderProducts();};info.append(button);}
  article.append(info);return article;
}

function renderProducts(){const container=$('#products');container.replaceChildren(...state.selection.map(product=>card(product)));$('#result-products').replaceChildren(...state.selection.map(product=>card(product)));}

function renderCart(){
  $('#cart-count').textContent=state.cart.length;const products=state.cart.map(id=>state.catalogue.find(x=>x.catalog_id===id)).filter(Boolean),container=$('#cart-items');container.replaceChildren();
  if(!products.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Votre panier est vide.';container.append(empty);return;}
  for(const product of products){const row=document.createElement('div');row.className='cart-item';const img=document.createElement('img');img.src=product.image_url;img.alt='';const text=document.createElement('div');const strong=document.createElement('strong');strong.textContent=product.product_name;const small=document.createElement('small');small.textContent=`${product.retailer} · ${money(product)}`;text.append(strong,small);const remove=document.createElement('button');remove.className='link-button';remove.textContent='Retirer';remove.onclick=()=>{state.cart=state.cart.filter(id=>id!==product.catalog_id);saveCart();renderProducts();};row.append(img,text,remove);container.append(row);}
}

function requiredRoles(){const roles=[...plans[state.programme]];if(state.programme==='living_dining'&&state.includeTV)roles.push('tv_unit');if(state.surfaces.floor==='replace')roles.push('floor_finish');if(state.surfaces.walls==='replace')roles.push('wall_finish');return roles;}
async function digest(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}

async function rebuildSelection({clearResults=true}={}){
  const byRole=Object.groupBy(state.catalogue,product=>product.role),roles=requiredRoles();
  state.selection=roles.map((role,index)=>{const choices=byRole[role]||[];if(!choices.length)throw new Error(`Références ${roleLabels[role]||role} indisponibles.`);return choices[(state.variant+index)%choices.length];});
  const canonical=JSON.stringify({program:state.programme,include_tv:Boolean(state.includeTV),surfaces:state.surfaces,products:state.selection.map(x=>({catalog_id:x.catalog_id,role:x.role,quantity:x.quantity}))});
  state.fingerprint=await digest(canonical);if(clearResults){state.results={};state.compare=false;}renderProducts();renderResults();updateGenerate();
}

function providerLabel(id){return id==='muse'?'Muse Image':'OpenAI Image';}
function updateEngine(){for(const button of $$('.engine')){const active=button.dataset.provider===state.provider;button.classList.toggle('active',active);button.setAttribute('aria-checked',String(active));}updateGenerate();}
function updateGenerate(){
  const configured=state.providers[state.provider]?.configured,button=$('#generate-button');
  $('#provider-ready').textContent=configured?`${providerLabel(state.provider)} prêt`:`${providerLabel(state.provider)} non configuré`;
  if(!state.photoPath){button.textContent='Ajouter une photo pour générer';button.disabled=true;return;}
  button.textContent=state.results[state.provider]?.selection_fingerprint===state.fingerprint?`${providerLabel(state.provider)} déjà généré`:`Générer avec ${providerLabel(state.provider)} · Image payante`;
  button.disabled=!configured||!$('#paid-confirm').checked||Boolean(state.results[state.provider]?.selection_fingerprint===state.fingerprint);
}

function renderResults(){
  const valid=Object.values(state.results).filter(result=>result.selection_fingerprint===state.fingerprint),panel=$('#results-panel');panel.hidden=!valid.length;if(!valid.length)return;
  const single=state.results[state.provider]?.selection_fingerprint===state.fingerprint?state.results[state.provider]:valid[0];
  const figure=result=>{const f=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');img.src=result.image_url;img.alt=`Rendu ${providerLabel(result.provider)}`;caption.textContent=`${providerLabel(result.provider)} · revue humaine requise · ${Math.round(result.elapsed_ms/1000)} s`;f.append(img,caption);return f;};
  $('#result-single').replaceChildren(figure(single));
  const pair=['openai','muse'].map(id=>state.results[id]).filter(result=>result?.selection_fingerprint===state.fingerprint),toggle=$('#compare-toggle');toggle.hidden=pair.length!==2;
  $('#result-compare').replaceChildren(...pair.map(figure));$('#result-single').hidden=state.compare&&pair.length===2;$('#result-compare').hidden=!(state.compare&&pair.length===2);toggle.textContent=state.compare?'Voir le rendu seul':'Comparer côte à côte';
}

async function optimizePhoto(file){
  const bitmap=await createImageBitmap(file),max=1800,ratio=Math.min(1,max/Math.max(bitmap.width,bitmap.height));let width=Math.max(320,Math.round(bitmap.width*ratio)),height=Math.max(320,Math.round(bitmap.height*ratio));
  let quality=.86,blob;
  for(let attempt=0;attempt<5;attempt++){
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{alpha:false});context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(bitmap,0,0,width,height);
    blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));if(blob&&blob.size<=3_500_000)break;width=Math.round(width*.82);height=Math.round(height*.82);quality=Math.max(.68,quality-.05);
  }
  bitmap.close();if(!blob||blob.size>3_500_000)throw new Error('La photo ne peut pas être optimisée sous la limite Vercel.');return {blob,width,height};
}

async function upload(file){
  setMessage('Optimisation locale de la photo…');const optimized=await optimizePhoto(file);setMessage('Envoi vers le stockage privé…');
  const uploaded=await api('/api/upload',{method:'POST',headers:{'Content-Type':optimized.blob.type},body:optimized.blob});
  if(state.photoURL)URL.revokeObjectURL(state.photoURL);state.photoURL=URL.createObjectURL(optimized.blob);state.photoPath=uploaded.pathname;state.photoName=file.name;state.width=optimized.width;state.height=optimized.height;state.results={};state.compare=false;
  $('#photo-preview').src=state.photoURL;$('#photo-name').textContent=file.name;$('#photo-meta').textContent=`${optimized.width} × ${optimized.height} · ${(optimized.blob.size/1024/1024).toFixed(2)} Mo · stockage privé`;$('#upload-zone').hidden=true;$('#photo-preview-wrap').hidden=false;$('#paid-confirm').checked=false;setMessage('Photo prête. Aucun appel IA effectué.');updateGenerate();renderResults();
}

async function generate(){
  if(!state.photoPath||!state.fingerprint||!$('#paid-confirm').checked)return;
  const button=$('#generate-button');button.disabled=true;setMessage(`Génération ${providerLabel(state.provider)} en cours. Un seul appel est autorisé, sans retry…`);
  try{
    const result=await api('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:state.provider,program:state.programme,include_tv:state.includeTV,surfaces:state.surfaces,room_path:state.photoPath,width:state.width,height:state.height,product_ids:state.selection.map(x=>x.catalog_id),selection_fingerprint:state.fingerprint,authorization_id:crypto.randomUUID(),confirm_paid_generation:true})});
    state.results[state.provider]=result;$('#paid-confirm').checked=false;state.compare=false;renderResults();setMessage(`${providerLabel(state.provider)} a livré une image. Vérifiez l’architecture, les fixes et les produits avant toute acceptation.`);$('#results-panel').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){setMessage(error.message,'error');}finally{updateGenerate();}
}

async function boot(){
  const auth=await api('/api/auth');if(!auth.authenticated){$('#login-dialog').showModal();return;}
  const [catalogue,status]=await Promise.all([api('/api/catalogue'),api('/api/status')]);state.catalogue=catalogue.products;state.providers=status.providers;$('#app').hidden=false;$('#logout-button').hidden=false;$('#cart-button').hidden=false;await rebuildSelection();renderCart();updateEngine();
}

$('#login-form').addEventListener('submit',async event=>{event.preventDefault();$('#login-error').textContent='';try{await api('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#password').value})});$('#login-dialog').close();await boot();}catch(error){$('#login-error').textContent=error.message;}});
$('#logout-button').onclick=async()=>{await api('/api/auth',{method:'DELETE'});location.reload();};
$('#cart-button').onclick=()=>$('#cart-dialog').showModal();$('#close-cart').onclick=()=>$('#cart-dialog').close();
for(const button of $$('.engine'))button.onclick=()=>{state.provider=button.dataset.provider;state.compare=false;updateEngine();renderResults();setMessage(`Moteur ${providerLabel(state.provider)} sélectionné. Aucun appel effectué.`);};
for(const button of $$('.program'))button.onclick=async()=>{for(const x of $$('.program'))x.classList.toggle('active',x===button);state.programme=button.dataset.program;state.includeTV=false;$('#include-tv').checked=false;$('#tv-option').hidden=state.programme!=='living_dining';state.variant=0;await rebuildSelection();setMessage('Programme et sélection mis à jour gratuitement.');};
$('#include-tv').onchange=async event=>{state.includeTV=event.target.checked;state.variant=0;await rebuildSelection();};
for(const input of $$('input[name="floor"],input[name="walls"]'))input.onchange=async event=>{state.surfaces={...state.surfaces,[event.target.name]:event.target.value};state.variant=0;await rebuildSelection();setMessage('Surfaces et sélection mises à jour gratuitement.');};
$('#new-composition').onclick=async()=>{state.variant++;await rebuildSelection();setMessage('Nouvelle composition locale prête. Aucun appel IA effectué.');};
$('#photo-input').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{await upload(file);}catch(error){setMessage(error.message,'error');}};
$('#replace-photo').onclick=()=>$('#photo-input').click();$('#paid-confirm').onchange=updateGenerate;$('#generate-button').onclick=generate;
$('#compare-toggle').onclick=()=>{state.compare=!state.compare;renderResults();};

boot().catch(error=>{$('#login-dialog').showModal();$('#login-error').textContent=error.message;});
