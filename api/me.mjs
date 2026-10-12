import {requireIdentity} from './_identity.mjs';
import {sendJSON} from './_security.mjs';
import {supabaseUserFetch} from './_supabase.mjs';

const first=value=>Array.isArray(value)?value[0]??null:value??null;
const publicProject=value=>value&&typeof value==='object'?{...value,address:value.city??null}:value;

function anchoredMonth(value,offset) {
  const source=new Date(value);
  if(Number.isNaN(source.valueOf())||!Number.isSafeInteger(offset)||offset<0)return null;
  const absoluteMonth=source.getUTCFullYear()*12+source.getUTCMonth()+offset;
  const year=Math.floor(absoluteMonth/12),month=((absoluteMonth%12)+12)%12;
  const lastDay=new Date(Date.UTC(year,month+1,0)).getUTCDate();
  return new Date(Date.UTC(year,month,Math.min(source.getUTCDate(),lastDay),source.getUTCHours(),source.getUTCMinutes(),source.getUTCSeconds(),source.getUTCMilliseconds()));
}

export function subscriptionCreditWindow(subscription,now=Date.now()) {
  const startMs=Date.parse(subscription?.current_period_start),endMs=Date.parse(subscription?.current_period_end),nowMs=now instanceof Date?now.valueOf():Number(now);
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||!Number.isFinite(nowMs)||startMs>nowMs||endMs<=nowMs||endMs<=startMs)return null;
  if(subscription?.billing_interval!=='year')return {start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString()};

  const source=new Date(startMs),current=new Date(nowMs);
  let offset=Math.max(0,(current.getUTCFullYear()-source.getUTCFullYear())*12+current.getUTCMonth()-source.getUTCMonth());
  let windowStart=anchoredMonth(startMs,offset);
  if(!windowStart)return null;
  if(windowStart.valueOf()>nowMs&&offset>0){offset-=1;windowStart=anchoredMonth(startMs,offset);}
  let windowEnd=anchoredMonth(startMs,offset+1);
  while(windowEnd&&windowEnd.valueOf()<=nowMs&&windowEnd.valueOf()<endMs) {
    offset+=1;windowStart=windowEnd;windowEnd=anchoredMonth(startMs,offset+1);
  }
  if(!windowStart||!windowEnd)return null;
  return {start:windowStart.toISOString(),end:new Date(Math.min(endMs,windowEnd.valueOf())).toISOString()};
}

export default async function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  const {user,accessToken}=identity,userFilter=encodeURIComponent(user.id);
  try {
    const [profiles,projects,subscriptions]=await Promise.all([
      supabaseUserFetch(`profiles?select=first_name,last_name,company_name,phone,signup_mode,onboarding_completed_at,terms_version,terms_accepted_at&user_id=eq.${userFilter}&limit=1`,{accessToken}),
      supabaseUserFetch(`projects?select=id,name,property_type,city,room_type,style,status,created_at,updated_at&owner_id=eq.${userFilter}&status=eq.active&order=updated_at.desc&limit=100`,{accessToken}),
      supabaseUserFetch(`subscriptions?select=id,plan_code,billing_interval,status,current_period_start,current_period_end,cancel_at_period_end,updated_at&user_id=eq.${userFilter}&order=updated_at.desc&limit=20`,{accessToken}),
    ]);
    const profile=first(profiles),now=Date.now(),subscriptionRows=Array.isArray(subscriptions)?subscriptions:[];
    const liveSubscription=subscriptionRows.find(value=>value?.status==='active'&&Number.isFinite(Date.parse(value.current_period_start))&&Number.isFinite(Date.parse(value.current_period_end))&&Date.parse(value.current_period_start)<=now&&Date.parse(value.current_period_end)>now);
    const subscription=liveSubscription??first(subscriptionRows),creditWindow=liveSubscription?subscriptionCreditWindow(liveSubscription,now):null;let usage=null,plan=null;
    if(subscription) {
      const [periods,plans]=await Promise.all([
        creditWindow?supabaseUserFetch(`usage_periods?select=month_start,month_end,included_generations,reserved_generations,consumed_generations&user_id=eq.${userFilter}&subscription_id=eq.${encodeURIComponent(subscription.id)}&month_start=eq.${encodeURIComponent(creditWindow.start)}&month_end=eq.${encodeURIComponent(creditWindow.end)}&limit=1`,{accessToken}):Promise.resolve([]),
        supabaseUserFetch(`plans?select=code,name,credits_per_month&code=eq.${encodeURIComponent(subscription.plan_code)}&active=eq.true&limit=1`,{accessToken}),
      ]);
      usage=first(periods);plan=first(plans);
    }
    const active=Boolean(subscription&&subscription===liveSubscription);
    const included=usage?.included_generations??plan?.credits_per_month??0,reserved=usage?.reserved_generations??0,consumed=usage?.consumed_generations??0;
    const publicSubscription=subscription?{id:subscription.id,status:subscription.status,plan_code:subscription.plan_code,billing_period:subscription.billing_interval==='year'?'annual':'monthly',
      current_period_start:subscription.current_period_start,current_period_end:subscription.current_period_end,cancel_at_period_end:subscription.cancel_at_period_end,plan_name:plan?.name||subscription.plan_code}:null;
    const remaining=active?Math.max(0,included-reserved-consumed):0;
    const canGenerate=remaining>0,credits={remaining,limit:included,period_start:usage?.month_start??creditWindow?.start??null,period_end:usage?.month_end??creditWindow?.end??subscription?.current_period_end??null};
    return sendJSON(res,200,{user,profile,onboarding_complete:Boolean(profile?.onboarding_completed_at),terms_version:process.env.CLIENT_TERMS_VERSION||'2026-10-12',
      projects:Array.isArray(projects)?projects.map(publicProject):[],subscription:publicSubscription,can_generate:canGenerate,credits,
      entitlements:{can_generate:canGenerate,included_generations:included,reserved_generations:reserved,consumed_generations:consumed,remaining_generations:remaining}});
  } catch {return sendJSON(res,503,{error:'Espace client momentanément indisponible.',code:'client_portal_unavailable'});}
}

export const __test={anchoredMonth,subscriptionCreditWindow};
