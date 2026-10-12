import {createHmac,timingSafeEqual} from 'node:crypto';

export const BILLING_PLANS=Object.freeze({
  essential:Object.freeze({id:'essential',name:'Essentiel',credits_per_month:10,monthly_amount_cents:999,annual_amount_cents:7428,currency:'EUR'}),
  pro:Object.freeze({id:'pro',name:'Pro',credits_per_month:100,monthly_amount_cents:3999,annual_amount_cents:29988,currency:'EUR'}),
});

export class StripeRequestError extends Error {
  constructor(message,{status=502,code='stripe_request_failed'}={}){super(message);this.name='StripeRequestError';this.status=status;this.code=code;}
}

export function stripeConfigured() {return typeof process.env.STRIPE_SECRET_KEY==='string'&&process.env.STRIPE_SECRET_KEY.startsWith('sk_');}
export function assertStripeConfigured() {if(!stripeConfigured())throw new StripeRequestError('Facturation indisponible.',{status:503,code:'stripe_not_configured'});return process.env.STRIPE_SECRET_KEY;}
export function stripeWebhookConfigured() {return typeof process.env.STRIPE_WEBHOOK_SECRET==='string'&&process.env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_');}

export function normalizeBillingPeriod(value) {
  const period=String(value||'').toLowerCase();
  if(['month','monthly'].includes(period))return 'month';
  if(['year','yearly','annual'].includes(period))return 'year';
  return null;
}

export function stripePriceFor(planId,periodValue) {
  const plan=BILLING_PLANS[planId],period=normalizeBillingPeriod(periodValue);
  if(!plan||!period)return null;
  const suffix=period==='month'?'MONTHLY':'ANNUAL',envName=`STRIPE_PRICE_${planId.toUpperCase()}_${suffix}`,priceId=String(process.env[envName]||'').trim();
  return /^price_[A-Za-z0-9]+$/.test(priceId)?{plan,period,priceId}:null;
}

export function priceDescriptor(priceId) {
  for(const planId of Object.keys(BILLING_PLANS))for(const period of ['month','year']) {
    const candidate=stripePriceFor(planId,period);if(candidate?.priceId===priceId)return candidate;
  }
  return null;
}

export function stripePriceMatchesOffer(price,offer) {
  if(!offer?.plan||!['month','year'].includes(offer.period))return false;
  const expectedAmount=offer.period==='month'?offer.plan.monthly_amount_cents:offer.plan.annual_amount_cents;
  return price?.id===offer.priceId&&price.active===true&&price.currency==='eur'&&price.type==='recurring'&&
    price.recurring?.interval===offer.period&&Number(price.recurring?.interval_count)===1&&Number(price.unit_amount)===expectedAmount;
}

export function publicPlans() {
  return Object.values(BILLING_PLANS).map(plan=>({id:plan.id,name:plan.name,credits_per_month:plan.credits_per_month,currency:plan.currency,
    prices:{monthly:{amount_cents:plan.monthly_amount_cents,available:Boolean(stripePriceFor(plan.id,'month'))},annual:{amount_cents:plan.annual_amount_cents,available:Boolean(stripePriceFor(plan.id,'year'))}}}));
}

export function appBaseURL() {
  const raw=String(process.env.PUBLIC_APP_URL||process.env.APP_BASE_URL||(process.env.VERCEL_PROJECT_PRODUCTION_URL?`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`:'')||'').trim();
  try {const url=new URL(raw);if(!url.username&&!url.password&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))return url.origin;}catch{}
  throw new StripeRequestError('URL publique de l’application absente.',{status:503,code:'app_url_not_configured'});
}

export function safeReturnPath(value,fallback='/app') {
  const path=typeof value==='string'?value.trim():'';
  return path.startsWith('/')&&!path.startsWith('//')&&!path.includes('\\')&&!/[\u0000-\u001f\u007f]/.test(path)&&path.length<=300?path:fallback;
}

export async function stripeFetch(path,{method='POST',params={},idempotencyKey,fetchImpl=fetch,timeoutMs=12_000}={}) {
  const secret=assertStripeConfigured(),clean=String(path||'').replace(/^\/+/, '');
  if(!clean||clean.includes('..')||clean.includes('\\')||clean.includes('\n')||clean.includes('\r'))throw new StripeRequestError('Chemin Stripe invalide.',{status:500,code:'invalid_stripe_path'});
  const encoded=new URLSearchParams();for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null)encoded.append(key,String(value));
  const url=method==='GET'&&encoded.size?`https://api.stripe.com/v1/${clean}?${encoded}`:`https://api.stripe.com/v1/${clean}`;
  const headers={Authorization:`Bearer ${secret}`};if(method!=='GET')headers['Content-Type']='application/x-www-form-urlencoded';if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
  let response;try{response=await fetchImpl(url,{method,headers,body:method==='GET'?undefined:encoded,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}catch{throw new StripeRequestError('Service de facturation injoignable.',{status:503,code:'stripe_unreachable'});}
  let payload=null;try{payload=await response.json();}catch{}
  if(!response.ok)throw new StripeRequestError('Service de facturation refusé.',{status:response.status>=400&&response.status<500?response.status:502,code:payload?.error?.code||'stripe_rejected'});
  return payload;
}

export function verifyStripeSignature(rawBody,header,secret=process.env.STRIPE_WEBHOOK_SECRET,{now=Math.floor(Date.now()/1000),tolerance=300}={}) {
  if(!Buffer.isBuffer(rawBody)||typeof header!=='string'||typeof secret!=='string'||!secret.startsWith('whsec_'))return false;
  const parts=header.split(',').map(item=>item.trim().split('=',2)),timestamp=Number(parts.find(([key])=>key==='t')?.[1]);
  const signatures=parts.filter(([key,value])=>key==='v1'&&/^[a-f0-9]{64}$/i.test(value||'')).map(([,value])=>value.toLowerCase());
  if(!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp)>tolerance||!signatures.length)return false;
  const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return signatures.some(value=>{const left=Buffer.from(value),right=Buffer.from(expected);return left.length===right.length&&timingSafeEqual(left,right);});
}

export const __test={safeReturnPath};
