import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

function addAnchoredUtcMonths(anchor,index) {
  const targetMonth=anchor.getUTCMonth()+index;
  const targetYear=anchor.getUTCFullYear()+Math.floor(targetMonth/12);
  const normalizedMonth=((targetMonth%12)+12)%12;
  const lastDay=new Date(Date.UTC(targetYear,normalizedMonth+1,0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(anchor.getUTCDate(),lastDay),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  ));
}

function annualCreditWindow(anchorValue,endValue,nowValue) {
  const anchor=new Date(anchorValue),end=new Date(endValue),now=new Date(nowValue);
  let index=(now.getUTCFullYear()-anchor.getUTCFullYear())*12+now.getUTCMonth()-anchor.getUTCMonth();
  let start=addAnchoredUtcMonths(anchor,index);
  if(start>now)start=addAnchoredUtcMonths(anchor,--index);
  const candidateEnd=addAnchoredUtcMonths(anchor,index+1);
  return [start,candidateEnd<end?candidateEnd:end].map(value=>value.toISOString());
}

test('generation credits use Stripe periods, never server calendar months',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/001_client_portal.sql',import.meta.url),'utf8');
  const reserve=sql.slice(sql.indexOf('create or replace function public.reserve_generation_credit'),sql.indexOf('create or replace function public.mark_generation_request_started'));
  const monthly=reserve.slice(reserve.indexOf("if current_subscription.billing_interval = 'month'"),reserve.indexOf("elsif current_subscription.billing_interval = 'year'"));
  const annual=reserve.slice(reserve.indexOf("elsif current_subscription.billing_interval = 'year'"),reserve.indexOf("else\n    raise exception 'invalid_subscription_period'"));

  assert.match(sql,/month_start timestamptz not null/);
  assert.match(sql,/month_end timestamptz not null/);
  assert.doesNotMatch(reserve,/date_trunc\('month'/);
  assert.match(monthly,/period_start := current_subscription\.current_period_start/);
  assert.match(monthly,/period_end := current_subscription\.current_period_end/);
  assert.match(annual,/period_candidate_start_utc := subscription_period_start_utc \+ make_interval\(months => period_month_index\)/);
  assert.match(annual,/period_candidate_end_utc := least\([\s\S]*subscription_period_start_utc \+ make_interval\(months => period_month_index \+ 1\),[\s\S]*subscription_period_end_utc/);
  assert.match(annual,/period_start := period_candidate_start_utc at time zone 'UTC'/);
  assert.match(annual,/period_end := period_candidate_end_utc at time zone 'UTC'/);
  assert.doesNotMatch(annual,/period_candidate_start_utc \+ interval '1 month'/);
});

test('annual Stripe anchors do not drift after a short month and the last window is bounded',()=>{
  const anchor='2024-01-31T08:15:00.000Z';
  const annualEnd='2025-01-31T08:15:00.000Z';
  assert.deepEqual(annualCreditWindow(anchor,annualEnd,'2024-02-15T12:00:00.000Z'),[
    '2024-01-31T08:15:00.000Z','2024-02-29T08:15:00.000Z',
  ]);
  assert.deepEqual(annualCreditWindow(anchor,annualEnd,'2024-03-30T12:00:00.000Z'),[
    '2024-02-29T08:15:00.000Z','2024-03-31T08:15:00.000Z',
  ]);
  assert.deepEqual(annualCreditWindow(anchor,annualEnd,'2024-03-31T08:15:00.000Z'),[
    '2024-03-31T08:15:00.000Z','2024-04-30T08:15:00.000Z',
  ]);
  assert.deepEqual(annualCreditWindow(anchor,'2024-03-15T08:15:00.000Z','2024-03-01T12:00:00.000Z'),[
    '2024-02-29T08:15:00.000Z','2024-03-15T08:15:00.000Z',
  ]);
});
