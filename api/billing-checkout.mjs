import {requireIdentity,validUUID} from './_identity.mjs';
import {readJSON,sameOrigin,sendJSON} from './_security.mjs';
import {BILLING_PLANS,appBaseURL,safeReturnPath,stripeFetch,stripePriceFor,stripePriceMatchesOffer,stripeWebhookConfigured} from './_stripe.mjs';
import {supabaseAdminFetch,supabaseAdminRpc,supabaseUserFetch} from './_supabase.mjs';
import {fetchAndSyncSubscription} from './billing-webhook.mjs';

const first=value=>Array.isArray(value)?value[0]??null:value??null;
const CHECKOUT_SESSION=/^cs_(?:test|live)_[A-Za-z0-9]+$/;
const SUBSCRIPTION_ID=/^sub_[A-Za-z0-9]+$/;

function studioReturnPath(value) {
  const candidate=safeReturnPath(value,'/studio.html');
  try {const parsed=new URL(candidate,'https://aurimmo.local');return parsed.origin==='https://aurimmo.local'&&parsed.pathname==='/studio.html'?candidate:'/studio.html';}
  catch{return '/studio.html';}
}

function checkoutReturnURLs(base,requestedReturn) {
  const returnPath=studioReturnPath(requestedReturn),query=new URLSearchParams({view:'plans',return_to:returnPath}).toString();
  const portal=`${base}/portal.html?${query}`;
  return {returnPath,successUrl:`${portal}&billing=success&session_id={CHECKOUT_SESSION_ID}`,cancelUrl:`${portal}&billing=cancelled`};
}

function validCheckoutURL(value) {
  if(typeof value!=='string'||value.length>4096)return null;
  try {const url=new URL(value);return url.protocol==='https:'&&url.hostname==='checkout.stripe.com'&&!url.username&&!url.password?url.href:null;}
  catch{return null;}
}

function checkoutExpiry(value,{now=Math.floor(Date.now()/1000)}={}) {
  const seconds=Number(value);
  if(!Number.isSafeInteger(seconds)||seconds<=now||seconds>now+172800)return null;
  return new Date(seconds*1000).toISOString();
}

function claimedOffer(claim) {
  const plan=BILLING_PLANS[claim?.selected_plan_code],period=claim?.selected_billing_interval,priceId=claim?.selected_stripe_price_id;
  return plan&&['month','year'].includes(period)&&/^price_[A-Za-z0-9]+$/.test(priceId||'')?{plan,period,priceId}:null;
}

function publicCheckout(claim,{resumed=false}={}) {
  const url=validCheckoutURL(claim?.checkout_session_url),sessionId=String(claim?.checkout_session_id||'');
  if(!url||!CHECKOUT_SESSION.test(sessionId))throw Object.assign(new Error('invalid_checkout_record'),{code:'invalid_checkout_record'});
  return {url,checkout_url:url,checkout_session_id:sessionId,plan_id:claim.selected_plan_code,
    period:claim.selected_billing_interval==='year'?'yearly':'monthly',resumed};
}

async function customerFor(identity) {
  const rows=await supabaseUserFetch(`billing_customers?select=stripe_customer_id&user_id=eq.${encodeURIComponent(identity.user.id)}&limit=1`,{accessToken:identity.accessToken});
  const existing=first(rows);if(existing?.stripe_customer_id)return existing.stripe_customer_id;
  const customer=await stripeFetch('customers',{params:{email:identity.user.email,'metadata[supabase_user_id]':identity.user.id},idempotencyKey:`aurimmo-customer-${identity.user.id}`});
  if(!/^cus_[A-Za-z0-9]+$/.test(customer?.id||''))throw new Error('invalid_stripe_customer');
  await supabaseAdminFetch('billing_customers?on_conflict=user_id',{method:'POST',body:{user_id:identity.user.id,stripe_customer_id:customer.id},headers:{Prefer:'resolution=merge-duplicates,return=minimal'}});
  return customer.id;
}

async function beginCheckout(identity,offer,returnPath,replaceSessionId=null) {
  const value=await supabaseAdminRpc('begin_billing_checkout',{
    p_user_id:identity.user.id,
    p_plan_code:offer.plan.id,
    p_billing_interval:offer.period,
    p_stripe_price_id:offer.priceId,
    p_return_path:returnPath,
    p_replace_session_id:CHECKOUT_SESSION.test(String(replaceSessionId||''))?replaceSessionId:null,
  });
  const claim=first(value);
  if(!claim?.checkout_action)throw Object.assign(new Error('invalid_checkout_claim'),{code:'invalid_checkout_claim'});
  return claim;
}

async function finishReplacement(identity,claim,status) {
  const value=await supabaseAdminRpc('finish_billing_checkout_replacement',{
    p_user_id:identity.user.id,p_intent_id:claim.checkout_intent_id,
    p_session_id:claim.checkout_session_id,p_terminal_status:status,
  });
  const finished=Array.isArray(value)?value[0]?.finish_billing_checkout_replacement??value[0]:value;
  if(finished!==true)throw Object.assign(new Error('checkout_state_conflict'),{status:409,code:'checkout_state_conflict'});
}

async function expireCheckout(identity,claim) {
  const sessionId=String(claim?.checkout_session_id||'');
  if(!validUUID(claim?.checkout_intent_id)||!CHECKOUT_SESSION.test(sessionId))throw Object.assign(new Error('invalid_checkout_claim'),{code:'invalid_checkout_claim'});
  let remote=await stripeFetch(`checkout/sessions/${sessionId}`,{method:'GET'});
  const remoteIntent=remote?.metadata?.checkout_intent_id;
  if(remote?.id!==sessionId||remote?.client_reference_id!==identity.user.id||remoteIntent!==claim.checkout_intent_id)
    throw Object.assign(new Error('checkout_identity_conflict'),{status:409,code:'checkout_identity_conflict'});
  if(remote.status==='complete') {
    await finishReplacement(identity,claim,'completed');
    throw Object.assign(new Error('subscription_pending'),{status:409,code:'subscription_pending'});
  }
  if(remote.status==='open')remote=await stripeFetch(`checkout/sessions/${sessionId}/expire`,{idempotencyKey:`aurimmo-checkout-expire-${claim.checkout_intent_id}`});
  if(remote?.id!==sessionId||remote?.status!=='expired')throw Object.assign(new Error('checkout_expiration_failed'),{status:409,code:'checkout_expiration_failed'});
  await finishReplacement(identity,claim,'expired');
}

function checkoutActionError(action,claim) {
  if(action==='subscription_exists')return Object.assign(new Error('subscription_exists'),{status:409,code:'subscription_exists'});
  if(action==='subscription_pending')return Object.assign(new Error('subscription_pending'),{status:409,code:'subscription_pending'});
  if(action==='subscription_reconciliation_required')return Object.assign(new Error('subscription_reconciliation_required'),{status:409,code:'subscription_reconciliation_required'});
  if(action==='busy')return Object.assign(new Error('checkout_busy'),{status:409,code:'checkout_busy'});
  if(action==='creating_other_offer')return Object.assign(new Error('checkout_creation_pending'),{status:409,code:'checkout_creation_pending'});
  if(action==='open_other_offer') {
    const error=Object.assign(new Error('checkout_session_open'),{status:409,code:'checkout_session_open'});
    try {error.checkout=publicCheckout(claim,{resumed:true});}catch{}
    return error;
  }
  return Object.assign(new Error('invalid_checkout_claim'),{code:'invalid_checkout_claim'});
}

function activePeriodIsCurrent(subscription,now=Date.now()) {
  if(subscription?.status!=='active')return false;
  const start=Date.parse(subscription.current_period_start),end=Date.parse(subscription.current_period_end);
  return Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&end>now;
}

async function reconcileExpiredActiveSubscriptions(identity,{now=Date.now(),subscriptions=null,sync=fetchAndSyncSubscription}={}) {
  const rows=subscriptions??await supabaseUserFetch(
    `subscriptions?select=stripe_subscription_id,status,current_period_start,current_period_end,stripe_event_created&user_id=eq.${encodeURIComponent(identity.user.id)}&status=eq.active&order=updated_at.desc&limit=2`,
    {accessToken:identity.accessToken},
  );
  let reconciled=0;
  for(const subscription of Array.isArray(rows)?rows:rows?[rows]:[]) {
    if(subscription?.status!=='active'||activePeriodIsCurrent(subscription,now))continue;
    const subscriptionId=String(subscription.stripe_subscription_id||'');
    if(!SUBSCRIPTION_ID.test(subscriptionId))throw Object.assign(new Error('subscription_reconciliation_required'),{status:409,code:'subscription_reconciliation_required'});
    const eventCreated=Number(subscription.stripe_event_created);
    if(!Number.isSafeInteger(eventCreated)||eventCreated<1)throw Object.assign(new Error('subscription_reconciliation_required'),{status:409,code:'subscription_reconciliation_required'});
    try {
      await sync(subscriptionId,eventCreated,{candidateUserId:identity.user.id});
      reconciled+=1;
    } catch(error) {
      throw Object.assign(new Error('subscription_reconciliation_failed'),{status:503,code:'subscription_reconciliation_failed',cause:error});
    }
  }
  return reconciled;
}

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  try {
    if(!stripeWebhookConfigured())return sendJSON(res,503,{error:'La souscription est momentanément indisponible.',code:'stripe_webhook_not_configured'});
    const body=await readJSON(req,16*1024),planId=String(body.plan_id??body.plan_code??'').toLowerCase(),periodValue=body.period??body.billing_period;
    const requestedOffer=stripePriceFor(planId,periodValue);if(!requestedOffer)return sendJSON(res,400,{error:'Forfait ou période indisponible.',code:'invalid_plan'});
    const profiles=await supabaseUserFetch(`profiles?select=onboarding_completed_at&user_id=eq.${encodeURIComponent(identity.user.id)}&limit=1`,{accessToken:identity.accessToken});
    if(!first(profiles)?.onboarding_completed_at)return sendJSON(res,409,{error:'Terminez d’abord les informations de votre projet.',code:'onboarding_required'});
    await reconcileExpiredActiveSubscriptions(identity);

    const returnPath=studioReturnPath(body.return_to),replaceSessionId=String(body.replace_checkout_session_id||'')||null;
    if(replaceSessionId&&!CHECKOUT_SESSION.test(replaceSessionId))return sendJSON(res,400,{error:'Session de paiement invalide.',code:'invalid_checkout_session'});
    let claim=await beginCheckout(identity,requestedOffer,returnPath,replaceSessionId);
    if(claim.checkout_action==='expire') {
      await expireCheckout(identity,claim);
      claim=await beginCheckout(identity,requestedOffer,returnPath,null);
    }
    if(claim.checkout_action==='resume')return sendJSON(res,200,publicCheckout(claim,{resumed:true}));
    if(claim.checkout_action!=='create')throw checkoutActionError(claim.checkout_action,claim);

    const offer=claimedOffer(claim);if(!offer)throw Object.assign(new Error('invalid_checkout_offer'),{code:'invalid_checkout_offer'});
    const configuredPrice=await stripeFetch(`prices/${offer.priceId}`,{method:'GET'});
    if(!stripePriceMatchesOffer(configuredPrice,offer))return sendJSON(res,503,{error:'Cette formule est momentanément indisponible.',code:'stripe_price_mismatch'});
    const customer=await customerFor(identity),base=appBaseURL(),{successUrl,cancelUrl}=checkoutReturnURLs(base,claim.selected_return_path);
    const session=await stripeFetch('checkout/sessions',{idempotencyKey:`aurimmo-checkout-${claim.checkout_intent_id}`,params:{mode:'subscription',customer,
      'line_items[0][price]':offer.priceId,'line_items[0][quantity]':'1',success_url:successUrl,cancel_url:cancelUrl,client_reference_id:identity.user.id,
      'metadata[checkout_intent_id]':claim.checkout_intent_id,'metadata[supabase_user_id]':identity.user.id,'metadata[plan_code]':offer.plan.id,'metadata[billing_interval]':offer.period,
      'subscription_data[metadata][supabase_user_id]':identity.user.id,'subscription_data[metadata][plan_code]':offer.plan.id,'subscription_data[metadata][billing_interval]':offer.period}});
    const sessionId=String(session?.id||''),url=validCheckoutURL(session?.url),expiresAt=checkoutExpiry(session?.expires_at);
    if(!CHECKOUT_SESSION.test(sessionId)||!url||!expiresAt||session?.status!=='open')throw Object.assign(new Error('invalid_checkout_session'),{code:'invalid_checkout_session'});
    const attached=await supabaseAdminRpc('attach_billing_checkout_session',{
      p_user_id:identity.user.id,p_intent_id:claim.checkout_intent_id,p_session_id:sessionId,p_checkout_url:url,p_expires_at:expiresAt,
    });
    const attachedValue=Array.isArray(attached)?attached[0]?.attach_billing_checkout_session??attached[0]:attached;
    if(attachedValue!==true)throw Object.assign(new Error('checkout_state_conflict'),{status:409,code:'checkout_state_conflict'});
    return sendJSON(res,201,{url,checkout_url:url,checkout_session_id:sessionId,plan_id:offer.plan.id,period:offer.period==='year'?'yearly':'monthly',resumed:false});
  } catch(error) {
    const status=Number(error.status)||503,payload={error:status>=500?'Création du paiement momentanément indisponible.':'Le paiement ne peut pas être préparé.',code:error.code||'checkout_failed'};
    if(error.checkout)Object.assign(payload,error.checkout);
    return sendJSON(res,status,payload);
  }
}

export const __test={customerFor,studioReturnPath,checkoutReturnURLs,validCheckoutURL,checkoutExpiry,claimedOffer,publicCheckout,checkoutActionError,activePeriodIsCurrent,reconcileExpiredActiveSubscriptions};
