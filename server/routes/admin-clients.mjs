import {normalizeEmail,requireIdentity,validUUID} from '../../api/_identity.mjs';
import {sendJSON} from '../../api/_security.mjs';
import {supabaseAdminFetch} from '../../api/_supabase.mjs';

const PAGE_SIZE=500;
const MAX_ROWS=10_000;
const ACTIVE_SUBSCRIPTION_STATUSES=new Set(['active']);
const PLAN_CODES=new Set(['essential','pro']);
const GENERATION_STATUSES=new Set(['reserved','request_started','saved','failed_before_request','failed_after_request','reconciliation_required']);
const RUN_ID=/^run-[A-Za-z0-9-]{8,120}$/;

const iso=value=>{
  if(typeof value!=='string'||value.length>40)return null;
  const date=new Date(value);
  return Number.isNaN(date.valueOf())?null:date.toISOString();
};

const nonNegative=value=>{
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>=0?number:0;
};

const cleanText=(value,max=120)=>typeof value==='string'?value.trim().slice(0,max):'';

export function adminEmailsFrom(value=process.env.ADMIN_EMAILS) {
  return new Set(String(value||'').split(/[,;\n]/).map(normalizeEmail).filter(Boolean));
}

export function isAdminIdentity(identity,value=process.env.ADMIN_EMAILS) {
  const email=normalizeEmail(identity?.user?.email);
  return Boolean(email&&adminEmailsFrom(value).has(email));
}

async function allRows(path,{maxRows=MAX_ROWS}={}) {
  const rows=[];
  for(let start=0;start<maxRows;start+=PAGE_SIZE) {
    const separator=path.includes('?')?'&':'?';
    const page=await supabaseAdminFetch(`${path}${separator}limit=${Math.min(PAGE_SIZE,maxRows-start)}&offset=${start}`);
    const values=Array.isArray(page)?page:[];
    rows.push(...values);
    if(values.length<PAGE_SIZE)return {rows,truncated:false};
  }
  return {rows,truncated:true};
}

function latestByUser(rows) {
  const result=new Map();
  for(const row of rows) {
    if(!validUUID(row?.user_id))continue;
    const previous=result.get(row.user_id);
    const currentTime=new Date(row.updated_at||row.created_at||0).valueOf()||0;
    const previousTime=new Date(previous?.updated_at||previous?.created_at||0).valueOf()||0;
    if(!previous||currentTime>=previousTime)result.set(row.user_id,row);
  }
  return result;
}

function subscriptionActive(subscription,now) {
  if(!subscription||!ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status))return false;
  const start=subscription.current_period_start?new Date(subscription.current_period_start).valueOf():null;
  const end=subscription.current_period_end?new Date(subscription.current_period_end).valueOf():null;
  return Number.isFinite(start)&&Number.isFinite(end)&&start<=now.valueOf()&&end>now.valueOf();
}

function subscriptionsByUser(rows,now) {
  const result=latestByUser(rows);
  for(const row of rows) {
    if(!validUUID(row?.user_id)||!subscriptionActive(row,now))continue;
    const previous=result.get(row.user_id);
    if(!subscriptionActive(previous,now)||new Date(row.updated_at||row.created_at||0).valueOf()>=new Date(previous?.updated_at||previous?.created_at||0).valueOf())result.set(row.user_id,row);
  }
  return result;
}

function emptyGenerationCounts() {
  return {total:0,saved:0,reconciliation_required:0,request_started:0,reserved:0,failed_before_request:0,failed_after_request:0};
}

function addGeneration(counts,status) {
  counts.total+=1;
  if(GENERATION_STATUSES.has(status))counts[status]+=1;
}

function later(...values) {
  const timestamps=values.map(iso).filter(Boolean).sort();
  return timestamps.at(-1)||null;
}

function publicSubscription(value,now) {
  if(!value)return null;
  const plan=PLAN_CODES.has(value.plan_code)?value.plan_code:null;
  const interval=value.billing_interval==='year'?'year':value.billing_interval==='month'?'month':null;
  const allowedStatuses=new Set(['incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused']);
  const status=allowedStatuses.has(value.status)?value.status:'unknown';
  return {
    plan_code:plan,
    billing_interval:interval,
    status,
    active:subscriptionActive(value,now),
    cancel_at_period_end:Boolean(value.cancel_at_period_end),
    current_period_end:iso(value.current_period_end),
    updated_at:iso(value.updated_at),
  };
}

export function aggregateAdminData({profiles=[],subscriptions=[],usagePeriods=[],generationAttempts=[],projects=[]},{now=new Date()}={}) {
  const safeNow=Number.isNaN(now.valueOf())?new Date():now;
  const latestSubscriptions=subscriptionsByUser(subscriptions,safeNow);
  const usageByUser=new Map();
  const generationsByUser=new Map();
  const projectsByUser=new Map();
  const projectLatestByUser=new Map();
  const generationLatestByUser=new Map();
  const reconciliations=[];

  for(const row of usagePeriods) {
    if(!validUUID(row?.user_id)||!validUUID(row?.subscription_id))continue;
    const subscription=latestSubscriptions.get(row.user_id);
    if(!subscriptionActive(subscription,safeNow)||row.subscription_id!==subscription.id)continue;
    const periodStart=new Date(row.month_start).valueOf(),periodEnd=new Date(row.month_end).valueOf();
    if(!Number.isFinite(periodStart)||!Number.isFinite(periodEnd)||periodStart>safeNow.valueOf()||periodEnd<=safeNow.valueOf())continue;
    const current=usageByUser.get(row.user_id)||{included:0,reserved:0,consumed:0,remaining:0};
    current.included+=nonNegative(row.included_generations);
    current.reserved+=nonNegative(row.reserved_generations);
    current.consumed+=nonNegative(row.consumed_generations);
    current.remaining=Math.max(0,current.included-current.reserved-current.consumed);
    usageByUser.set(row.user_id,current);
  }

  for(const row of generationAttempts) {
    if(!validUUID(row?.user_id))continue;
    const counts=generationsByUser.get(row.user_id)||emptyGenerationCounts();
    addGeneration(counts,String(row.status||''));
    generationsByUser.set(row.user_id,counts);
    generationLatestByUser.set(row.user_id,later(generationLatestByUser.get(row.user_id),row.updated_at,row.created_at));
    if(row.status==='reconciliation_required'
      &&validUUID(row.authorization_id)
      &&validUUID(row.project_id)
      &&typeof row.run_id==='string'
      &&RUN_ID.test(row.run_id)
      &&row.run_id===`run-${row.authorization_id.toLowerCase()}`) {
      reconciliations.push({
        authorization_id:row.authorization_id.toLowerCase(),
        run_id:row.run_id,
        user_id:row.user_id,
        project_id:row.project_id,
        request_started_at:iso(row.request_started_at),
        created_at:iso(row.created_at),
        updated_at:iso(row.updated_at),
      });
    }
  }

  for(const row of projects) {
    const ownerId=row?.owner_id;
    if(!validUUID(ownerId))continue;
    projectsByUser.set(ownerId,(projectsByUser.get(ownerId)||0)+1);
    projectLatestByUser.set(ownerId,later(projectLatestByUser.get(ownerId),row.updated_at,row.created_at));
  }

  const clients=[];
  for(const profile of profiles) {
    if(!validUUID(profile?.user_id))continue;
    const subscription=publicSubscription(latestSubscriptions.get(profile.user_id),safeNow);
    const usage=usageByUser.get(profile.user_id)||{included:0,reserved:0,consumed:0,remaining:0};
    const generations=generationsByUser.get(profile.user_id)||emptyGenerationCounts();
    clients.push({
      user_id:profile.user_id,
      email:normalizeEmail(profile.email),
      first_name:cleanText(profile.first_name,80)||null,
      last_name:cleanText(profile.last_name,80)||null,
      company_name:cleanText(profile.company_name,120)||null,
      signup_mode:['public_otp','email_password','admin_invite'].includes(profile.signup_mode)?profile.signup_mode:null,
      onboarding_completed:Boolean(profile.onboarding_completed_at),
      created_at:iso(profile.created_at),
      subscription,
      usage,
      generations,
      projects:projectsByUser.get(profile.user_id)||0,
      last_activity_at:later(profile.updated_at,subscription?.updated_at,projectLatestByUser.get(profile.user_id),generationLatestByUser.get(profile.user_id)),
    });
  }

  clients.sort((a,b)=>String(b.last_activity_at||b.created_at||'').localeCompare(String(a.last_activity_at||a.created_at||'')));
  const activeClients=clients.filter(client=>client.subscription?.active);
  const credits=clients.reduce((sum,client)=>{
    sum.included+=client.usage.included;
    sum.reserved+=client.usage.reserved;
    sum.consumed+=client.usage.consumed;
    sum.remaining+=client.usage.remaining;
    return sum;
  },{included:0,reserved:0,consumed:0,remaining:0});
  const generations=clients.reduce((sum,client)=>{
    for(const key of Object.keys(sum))sum[key]+=client.generations[key]||0;
    return sum;
  },emptyGenerationCounts());

  return {
    as_of:safeNow.toISOString(),
    summary:{
      clients:clients.length,
      onboarded:clients.filter(client=>client.onboarding_completed).length,
      active_subscriptions:activeClients.length,
      plans:{
        essential:activeClients.filter(client=>client.subscription?.plan_code==='essential').length,
        pro:activeClients.filter(client=>client.subscription?.plan_code==='pro').length,
      },
      credits,
      generations,
      projects:projects.length,
    },
    clients,
    reconciliations:reconciliations.sort((a,b)=>String(a.updated_at||a.created_at||'').localeCompare(String(b.updated_at||b.created_at||''))),
  };
}

export default async function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  if(!isAdminIdentity(identity))return sendJSON(res,403,{error:'Accès administrateur refusé.',code:'admin_required'});

  try {
    const [profiles,subscriptions,usagePeriods,generationAttempts,projects]=await Promise.all([
      allRows('profiles?select=user_id,email,first_name,last_name,company_name,signup_mode,onboarding_completed_at,created_at,updated_at&order=user_id.asc'),
      allRows('subscriptions?select=id,user_id,plan_code,billing_interval,status,current_period_start,current_period_end,cancel_at_period_end,created_at,updated_at&order=user_id.asc,updated_at.asc'),
      allRows('usage_periods?select=user_id,subscription_id,month_start,month_end,included_generations,reserved_generations,consumed_generations,updated_at&order=user_id.asc,month_start.asc'),
      allRows('generation_attempts?select=authorization_id,run_id,user_id,project_id,status,request_started_at,created_at,updated_at&order=user_id.asc,created_at.asc'),
      allRows('projects?select=owner_id,status,created_at,updated_at&order=owner_id.asc,created_at.asc'),
    ]);
    const result=aggregateAdminData({
      profiles:profiles.rows,
      subscriptions:subscriptions.rows,
      usagePeriods:usagePeriods.rows,
      generationAttempts:generationAttempts.rows,
      projects:projects.rows,
    });
    return sendJSON(res,200,{
      generated_at:new Date().toISOString(),
      partial:[profiles,subscriptions,usagePeriods,generationAttempts,projects].some(value=>value.truncated),
      admin:{email:identity.user.email},
      ...result,
    });
  } catch {
    return sendJSON(res,503,{error:'Le suivi clients est momentanément indisponible.',code:'admin_clients_unavailable'});
  }
}

export const __test={adminEmailsFrom,isAdminIdentity,aggregateAdminData,subscriptionActive,subscriptionsByUser,nonNegative};
