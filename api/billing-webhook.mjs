import {createHash} from 'node:crypto';
import {validUUID} from './_identity.mjs';
import {priceDescriptor,stripeFetch,verifyStripeSignature} from './_stripe.mjs';
import {supabaseAdminFetch,supabaseAdminRpc} from './_supabase.mjs';

const MAX_WEBHOOK_BYTES=1024*1024;
const SUPPORTED_EVENTS=new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

async function readRawBody(req,maxBytes=MAX_WEBHOOK_BYTES) {
  if(typeof req?.arrayBuffer==='function') {
    const declared=Number(req.headers?.get?.('content-length'));
    if(Number.isFinite(declared)&&declared>maxBytes)throw Object.assign(new Error('webhook_too_large'),{status:413,code:'webhook_too_large'});
    const body=Buffer.from(await req.arrayBuffer());
    if(body.length>maxBytes)throw Object.assign(new Error('webhook_too_large'),{status:413,code:'webhook_too_large'});
    return body;
  }
  const chunks=[];let total=0;
  for await(const chunk of req) {
    total+=chunk.length;
    if(total>maxBytes)throw Object.assign(new Error('webhook_too_large'),{status:413,code:'webhook_too_large'});
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function scalar(value,key) {
  if(typeof value==='string')return value;
  if(Array.isArray(value))return scalar(value[0],key);
  return value&&typeof value==='object'?value[key]??Object.values(value)[0]??null:null;
}

function stripeId(value,prefix) {
  const id=typeof value==='string'?value:value?.id;
  return new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id||'')?id:null;
}

function checkoutSessionId(value) {
  const id=typeof value==='string'?value:value?.id;
  return /^cs_(test|live)_[A-Za-z0-9]+$/.test(id||'')?id:null;
}

function unixTimestamp(value) {
  const seconds=Number(value);
  if(!Number.isSafeInteger(seconds)||seconds<1)return null;
  const date=new Date(seconds*1000);
  return Number.isNaN(date.valueOf())?null:date.toISOString();
}

function subscriptionIdFrom(value) {
  return stripeId(value?.subscription,'sub')||stripeId(value?.parent?.subscription_details?.subscription,'sub');
}

async function mappedUser(customerId,candidateUserId=null) {
  const rows=await supabaseAdminFetch(`billing_customers?select=user_id&stripe_customer_id=eq.${encodeURIComponent(customerId)}&limit=1`);
  const mapped=Array.isArray(rows)?rows[0]?.user_id:rows?.user_id;
  const candidate=validUUID(candidateUserId)?candidateUserId:null;
  if(mapped&&candidate&&mapped!==candidate)throw Object.assign(new Error('billing_identity_conflict'),{code:'billing_identity_conflict'});
  const userId=mapped||candidate;
  if(!validUUID(userId))throw Object.assign(new Error('billing_identity_missing'),{code:'billing_identity_missing'});
  return userId;
}

async function rememberCustomer(userId,customerId) {
  await supabaseAdminFetch('billing_customers?on_conflict=user_id',{method:'POST',body:{user_id:userId,stripe_customer_id:customerId},headers:{Prefer:'resolution=merge-duplicates,return=minimal'}});
}

function firstSubscriptionItem(subscription) {
  return Array.isArray(subscription?.items?.data)?subscription.items.data[0]??null:null;
}

async function syncSubscription(subscription,eventCreated,{candidateUserId=null}={}) {
  const subscriptionId=stripeId(subscription,'sub'),customerId=stripeId(subscription?.customer,'cus');
  if(!subscriptionId||!customerId)throw Object.assign(new Error('invalid_subscription_object'),{code:'invalid_subscription_object'});
  const item=firstSubscriptionItem(subscription),priceId=stripeId(item?.price,'price'),offer=priceDescriptor(priceId);
  if(!offer)throw Object.assign(new Error('unknown_stripe_price'),{code:'unknown_stripe_price'});
  const status=String(subscription.status||'');
  if(!['incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused'].includes(status))
    throw Object.assign(new Error('invalid_subscription_status'),{code:'invalid_subscription_status'});
  const metadataUserId=subscription?.metadata?.supabase_user_id;
  const userId=await mappedUser(customerId,metadataUserId||candidateUserId);
  await supabaseAdminRpc('sync_stripe_subscription',{
    p_user_id:userId,
    p_customer_id:customerId,
    p_subscription_id:subscriptionId,
    p_plan_code:offer.plan.id,
    p_billing_interval:offer.period,
    p_status:status,
    p_period_start:unixTimestamp(subscription.current_period_start??item?.current_period_start),
    p_period_end:unixTimestamp(subscription.current_period_end??item?.current_period_end),
    p_cancel_at_period_end:Boolean(subscription.cancel_at_period_end),
    p_latest_invoice_id:stripeId(subscription.latest_invoice,'in'),
    p_event_created:eventCreated,
  });
}

export async function fetchAndSyncSubscription(subscriptionId,eventCreated,options={}) {
  const subscription=await stripeFetch(`subscriptions/${subscriptionId}`,{method:'GET'});
  await syncSubscription(subscription,eventCreated,options);
}

async function processEvent(event) {
  if(!SUPPORTED_EVENTS.has(event.type))return;
  const object=event.data?.object;
  if(!object||typeof object!=='object')throw Object.assign(new Error('invalid_event_object'),{code:'invalid_event_object'});

  if(event.type==='checkout.session.expired'||event.type==='checkout.session.async_payment_failed') {
    const sessionId=checkoutSessionId(object);
    if(!sessionId)throw Object.assign(new Error('invalid_checkout_session'),{code:'invalid_checkout_session'});
    const subscriptionId=stripeId(object.subscription,'sub');
    if(event.type==='checkout.session.async_payment_failed'&&subscriptionId)
      await fetchAndSyncSubscription(subscriptionId,event.created,{candidateUserId:object.metadata?.supabase_user_id||object.client_reference_id});
    await supabaseAdminRpc('record_billing_checkout_event',{
      p_session_id:sessionId,
      p_status:event.type==='checkout.session.expired'?'expired':'failed',
      p_event_created:event.created,
    });
    return;
  }

  if(event.type==='checkout.session.completed'||event.type==='checkout.session.async_payment_succeeded') {
    const sessionId=checkoutSessionId(object);
    if(!sessionId)throw Object.assign(new Error('invalid_checkout_session'),{code:'invalid_checkout_session'});
    const customerId=stripeId(object.customer,'cus');
    if(!customerId)throw Object.assign(new Error('invalid_checkout_customer'),{code:'invalid_checkout_customer'});
    const candidate=object.metadata?.supabase_user_id||object.client_reference_id;
    const userId=await mappedUser(customerId,candidate);
    await rememberCustomer(userId,customerId);
    const subscriptionId=stripeId(object.subscription,'sub');
    if(!subscriptionId)throw Object.assign(new Error('checkout_subscription_missing'),{code:'checkout_subscription_missing'});
    await fetchAndSyncSubscription(subscriptionId,event.created,{candidateUserId:userId});
    await supabaseAdminRpc('record_billing_checkout_event',{p_session_id:sessionId,p_status:'completed',p_event_created:event.created});
    return;
  }

  if(event.type.startsWith('customer.subscription.')) {
    const subscriptionId=stripeId(object,'sub');
    if(!subscriptionId)throw Object.assign(new Error('invalid_subscription_object'),{code:'invalid_subscription_object'});
    await fetchAndSyncSubscription(subscriptionId,event.created,{candidateUserId:object.metadata?.supabase_user_id});
    return;
  }

  const subscriptionId=subscriptionIdFrom(object);
  if(subscriptionId)await fetchAndSyncSubscription(subscriptionId,event.created);
}

function errorCode(error) {
  const value=String(error?.code||error?.upstreamMessage||error?.message||'webhook_processing_failed');
  return /^[a-z][a-z0-9_]{2,80}$/.test(value)?value:'webhook_processing_failed';
}

const json=(status,payload)=>Response.json(payload,{status,headers:{'Cache-Control':'no-store'}});

export function GET() {return json(405,{error:'Méthode non disponible.'});}

export async function POST(req) {
  let rawBody;
  try {rawBody=await readRawBody(req);} catch(error) {return json(Number(error.status)||400,{error:'Webhook invalide.',code:error.code||'invalid_webhook'});}
  if(!verifyStripeSignature(rawBody,String(req.headers.get('stripe-signature')||'')))return json(400,{error:'Signature Stripe invalide.',code:'invalid_stripe_signature'});

  let event;
  try {event=JSON.parse(rawBody.toString('utf8'));}catch{return json(400,{error:'Webhook invalide.',code:'invalid_webhook_json'});}
  if(!stripeId(event?.id,'evt')||typeof event?.type!=='string'||event.type.length>120||!Number.isSafeInteger(event?.created)||event.created<1)
    return json(400,{error:'Webhook invalide.',code:'invalid_webhook_event'});
  const digest=createHash('sha256').update(rawBody).digest('hex');

  let claim;
  try {
    const result=await supabaseAdminRpc('claim_billing_event',{p_event_id:event.id,p_event_type:event.type,p_payload_sha256:digest,p_event_created:event.created});
    claim=scalar(result,'claim_billing_event');
  } catch {return json(503,{error:'Webhook temporairement indisponible.',code:'webhook_claim_failed'});}
  if(claim==='completed')return json(200,{received:true,duplicate:true});
  if(claim==='processing')return json(503,{error:'Webhook déjà en cours.',code:'webhook_processing'});
  if(claim==='conflict')return json(409,{error:'Conflit d’événement Stripe.',code:'webhook_event_conflict'});
  if(claim!=='claimed')return json(503,{error:'Webhook non traitable.',code:claim==='exhausted'?'webhook_attempts_exhausted':'webhook_claim_invalid'});

  try {
    await processEvent(event);
    await supabaseAdminRpc('finish_billing_event',{p_event_id:event.id,p_success:true,p_error_code:null});
    return json(200,{received:true});
  } catch(error) {
    const code=errorCode(error);
    try {await supabaseAdminRpc('finish_billing_event',{p_event_id:event.id,p_success:false,p_error_code:code});}catch{}
    return json(500,{error:'Traitement Stripe momentanément indisponible.',code});
  }
}

export const __test={SUPPORTED_EVENTS,readRawBody,scalar,stripeId,checkoutSessionId,unixTimestamp,subscriptionIdFrom,errorCode};
