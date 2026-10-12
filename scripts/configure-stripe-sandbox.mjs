import {spawnSync} from 'node:child_process';

const secret=String(process.env.STRIPE_SECRET_KEY||'').trim();
const appURL=String(process.env.PUBLIC_APP_URL||'https://aurimmo-muse-openai.vercel.app').replace(/\/$/,'');
if(!secret.startsWith('sk_test_'))throw new Error('Une clé Stripe sandbox sk_test_ est requise.');

async function stripe(path,{method='GET',params={},idempotencyKey}={}) {
  const body=new URLSearchParams();
  for(const [key,value] of Object.entries(params)) {
    if(Array.isArray(value))for(const item of value)body.append(key,String(item));
    else if(value!==undefined&&value!==null)body.append(key,String(value));
  }
  const suffix=method==='GET'&&body.size?`?${body}`:'';
  const headers={Authorization:`Bearer ${secret}`};
  if(method!=='GET')headers['Content-Type']='application/x-www-form-urlencoded';
  if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
  const response=await fetch(`https://api.stripe.com/v1/${path}${suffix}`,{method,headers,body:method==='GET'?undefined:body});
  const payload=await response.json();
  if(!response.ok)throw new Error(`Stripe ${path}: ${payload?.error?.code||response.status}`);
  return payload;
}

const offers=[
  {code:'essential',name:'Aurimmo Intérieur — Essentiel',monthly:999,annual:7428},
  {code:'pro',name:'Aurimmo Intérieur — Pro',monthly:3999,annual:29988},
];

async function productFor(offer) {
  const list=await stripe('products',{params:{active:'true',limit:'100'}});
  const existing=list.data?.find(item=>item.metadata?.aurimmo_plan===offer.code);
  if(existing)return existing;
  return stripe('products',{method:'POST',idempotencyKey:`aurimmo-product-${offer.code}-v1`,params:{
    name:offer.name,description:`${offer.code==='essential'?10:100} images par mois · sans essai · crédits non reportés`,
    'metadata[aurimmo_plan]':offer.code,
  }});
}

async function priceFor(product,offer,interval,amount) {
  const list=await stripe('prices',{params:{product:product.id,active:'true',type:'recurring',limit:'100'}});
  const existing=list.data?.find(item=>item.currency==='eur'&&item.unit_amount===amount&&item.recurring?.interval===interval&&item.recurring?.interval_count===1);
  if(existing)return existing;
  return stripe('prices',{method:'POST',idempotencyKey:`aurimmo-price-${offer.code}-${interval}-v1`,params:{
    product:product.id,currency:'eur',unit_amount:String(amount),'recurring[interval]':interval,'recurring[interval_count]':'1',
    'metadata[aurimmo_plan]':offer.code,'metadata[billing_interval]':interval,
  }});
}

function setVercelEnv(name,value) {
  for(const target of ['production','preview','development']) {
    const result=spawnSync('npx',['vercel','env','add',name,target,'--force'],{input:String(value),encoding:'utf8',stdio:['pipe','ignore','pipe']});
    if(result.status!==0)throw new Error(`Configuration Vercel refusée pour ${name}/${target}.`);
  }
}

const configured={};
for(const offer of offers) {
  const product=await productFor(offer);
  configured[`${offer.code}_monthly`]=await priceFor(product,offer,'month',offer.monthly);
  configured[`${offer.code}_annual`]=await priceFor(product,offer,'year',offer.annual);
}

setVercelEnv('STRIPE_PRICE_ESSENTIAL_MONTHLY',configured.essential_monthly.id);
setVercelEnv('STRIPE_PRICE_ESSENTIAL_ANNUAL',configured.essential_annual.id);
setVercelEnv('STRIPE_PRICE_PRO_MONTHLY',configured.pro_monthly.id);
setVercelEnv('STRIPE_PRICE_PRO_ANNUAL',configured.pro_annual.id);

const portalList=await stripe('billing_portal/configurations',{params:{limit:'100'}});
const portalProducts=offers.flatMap(offer=>{
  const productId=configured[`${offer.code}_monthly`].product;
  return [{productId,prices:[configured[`${offer.code}_monthly`].id,configured[`${offer.code}_annual`].id]}];
});
const portalParams={
  'business_profile[headline]':'Gérez votre abonnement Aurimmo Intérieur',
  'business_profile[privacy_policy_url]':`${appURL}/portal.html`,
  'business_profile[terms_of_service_url]':`${appURL}/portal.html`,
  'features[invoice_history][enabled]':'true',
  'features[payment_method_update][enabled]':'true',
  'features[subscription_cancel][enabled]':'true',
  'features[subscription_cancel][mode]':'at_period_end',
  'features[subscription_update][enabled]':'true',
  'features[subscription_update][default_allowed_updates][]':['price'],
  'features[subscription_update][proration_behavior]':'create_prorations',
};
portalProducts.forEach((entry,index)=>{
  portalParams[`features[subscription_update][products][${index}][product]`]=entry.productId;
  entry.prices.forEach((price,priceIndex)=>{portalParams[`features[subscription_update][products][${index}][prices][${priceIndex}]`]=price;});
});
const defaultPortal=portalList.data?.find(item=>item.is_default);
if(defaultPortal)await stripe(`billing_portal/configurations/${defaultPortal.id}`,{method:'POST',params:portalParams});
else await stripe('billing_portal/configurations',{method:'POST',idempotencyKey:'aurimmo-portal-v1',params:portalParams});

const webhookURL=`${appURL}/api/billing-webhook`;
const webhookEvents=[
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];
const webhookList=await stripe('webhook_endpoints',{params:{limit:'100'}});
let webhook=webhookList.data?.find(item=>item.url===webhookURL);
if(!webhook) {
  webhook=await stripe('webhook_endpoints',{method:'POST',idempotencyKey:'aurimmo-webhook-v1',params:{
    url:webhookURL,
    'enabled_events[]':webhookEvents,
    description:'Aurimmo Intérieur — synchronisation des abonnements',
  }});
  if(!String(webhook.secret||'').startsWith('whsec_'))throw new Error('Secret webhook Stripe absent.');
  setVercelEnv('STRIPE_WEBHOOK_SECRET',webhook.secret);
} else {
  webhook=await stripe(`webhook_endpoints/${webhook.id}`,{method:'POST',params:{
    url:webhookURL,
    'enabled_events[]':webhookEvents,
    description:'Aurimmo Intérieur — synchronisation des abonnements',
  }});
  if(!process.env.STRIPE_WEBHOOK_SECRET)
    throw new Error('Le webhook existe déjà mais son secret n’est pas disponible localement. Recréez-le explicitement.');
}

console.log('Stripe sandbox configuré : 2 produits, 4 tarifs, portail client et webhook.');
