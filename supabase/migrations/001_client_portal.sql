begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  first_name text,
  last_name text,
  company_name text,
  phone text,
  signup_mode text not null default 'public_otp',
  onboarding_completed_at timestamptz,
  terms_version text,
  terms_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_first_name_length check (first_name is null or char_length(first_name) between 1 and 80),
  constraint profiles_email_length check (email is null or char_length(email) between 3 and 254),
  constraint profiles_last_name_length check (last_name is null or char_length(last_name) between 1 and 80),
  constraint profiles_company_name_length check (company_name is null or char_length(company_name) <= 120),
  constraint profiles_phone_length check (phone is null or char_length(phone) <= 40),
  constraint profiles_signup_mode check (signup_mode in ('public_otp', 'email_password', 'admin_invite'))
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  property_type text not null,
  city text,
  notes text,
  room_type text not null default 'living_room',
  style text not null default 'japandi',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_name_length check (char_length(name) between 2 and 100),
  constraint projects_property_type check (property_type in ('apartment', 'house', 'studio', 'other')),
  constraint projects_city_length check (city is null or char_length(city) <= 120),
  constraint projects_notes_length check (notes is null or char_length(notes) <= 1000),
  constraint projects_room_type check (room_type = 'living_room'),
  constraint projects_style check (style = 'japandi'),
  constraint projects_status check (status in ('active', 'archived'))
);

create index if not exists projects_owner_updated_idx on public.projects(owner_id, updated_at desc);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  blob_path text not null unique,
  kind text not null,
  width integer,
  height integer,
  content_type text,
  bytes integer,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint assets_kind check (kind in ('source_photo', 'generated_result')),
  constraint assets_blob_path check (blob_path ~ '^(uploads|results)/[A-Za-z0-9._-]+$'),
  constraint assets_dimensions check ((width is null or width between 1 and 5000) and (height is null or height between 1 and 5000)),
  constraint assets_bytes check (bytes is null or bytes between 1 and 25000000)
);

create index if not exists assets_owner_project_idx on public.assets(owner_id, project_id, created_at desc);

create table if not exists public.plans (
  code text primary key,
  name text not null,
  credits_per_month integer not null,
  monthly_amount_cents integer not null,
  annual_amount_cents integer not null,
  currency text not null default 'EUR',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_code check (code in ('essential', 'pro')),
  constraint plans_credits check (credits_per_month > 0),
  constraint plans_amounts check (monthly_amount_cents > 0 and annual_amount_cents > 0),
  constraint plans_currency check (currency = 'EUR')
);

insert into public.plans(code, name, credits_per_month, monthly_amount_cents, annual_amount_cents, currency)
values
  ('essential', 'Essentiel', 10, 999, 7428, 'EUR'),
  ('pro', 'Pro', 100, 3999, 29988, 'EUR')
on conflict (code) do update set
  name = excluded.name,
  credits_per_month = excluded.credits_per_month,
  monthly_amount_cents = excluded.monthly_amount_cents,
  annual_amount_cents = excluded.annual_amount_cents,
  currency = excluded.currency,
  updated_at = now();

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_customers_stripe_id check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$')
);

-- One durable Checkout intent per customer prevents two concurrent HTTP requests
-- from creating two Stripe subscription sessions.  The intent UUID is also the
-- Stripe idempotency key material, so an ambiguous network result is safely
-- retried with the exact same parameters instead of opening a second session.
create table if not exists public.billing_checkout_intents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  intent_id uuid not null unique default gen_random_uuid(),
  plan_code text not null references public.plans(code),
  billing_interval text not null,
  stripe_price_id text not null,
  return_path text not null,
  status text not null default 'creating',
  stripe_checkout_session_id text unique,
  checkout_url text,
  expires_at timestamptz,
  lease_expires_at timestamptz not null default (now() + interval '2 minutes'),
  stripe_event_created bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_checkout_intents_interval check (billing_interval in ('month', 'year')),
  constraint billing_checkout_intents_price_id check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  constraint billing_checkout_intents_return_path check (
    char_length(return_path) <= 273
    and (return_path = '/studio.html' or left(return_path, 13) = '/studio.html?')
    and position(chr(92) in return_path) = 0
    and return_path !~ '[[:cntrl:]]'
  ),
  constraint billing_checkout_intents_status check (status in ('creating', 'open', 'cancelling', 'completed', 'expired', 'cancelled', 'failed')),
  constraint billing_checkout_intents_session_id check (stripe_checkout_session_id is null or stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  constraint billing_checkout_intents_url check (checkout_url is null or checkout_url ~ '^https://checkout\.stripe\.com/[^[:space:]]{1,3900}$'),
  constraint billing_checkout_intents_session_fields check (
    (stripe_checkout_session_id is null and checkout_url is null and expires_at is null)
    or (stripe_checkout_session_id is not null and checkout_url is not null and expires_at is not null)
  )
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,
  plan_code text not null references public.plans(code),
  billing_interval text not null,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  latest_invoice_id text,
  stripe_event_created bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_interval check (billing_interval in ('month', 'year')),
  constraint subscriptions_status check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  constraint subscriptions_customer_id check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  constraint subscriptions_subscription_id check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$')
);

create index if not exists subscriptions_user_updated_idx on public.subscriptions(user_id, updated_at desc);
create unique index if not exists subscriptions_one_live_per_user_idx
  on public.subscriptions(user_id)
  where status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused');

create table if not exists public.usage_periods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  month_start timestamptz not null,
  month_end timestamptz not null,
  included_generations integer not null,
  reserved_generations integer not null default 0,
  consumed_generations integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(subscription_id, month_start),
  constraint usage_period_dates check (month_end > month_start),
  constraint usage_period_counts check (
    included_generations >= 0 and reserved_generations >= 0 and consumed_generations >= 0
    and reserved_generations + consumed_generations <= included_generations
  )
);

create index if not exists usage_periods_user_month_idx on public.usage_periods(user_id, month_start desc);

create table if not exists public.generation_attempts (
  authorization_id uuid primary key,
  run_id text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_asset_id uuid not null references public.assets(id),
  usage_period_id uuid references public.usage_periods(id),
  provider text not null default 'muse',
  selection_fingerprint text not null,
  reservation_owner_id uuid not null,
  execution_id uuid,
  status text not null default 'reserved',
  credit_state text not null default 'reserved',
  request_started_at timestamptz,
  result_path text,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generation_attempts_run_id check (run_id ~ '^run-[A-Za-z0-9-]{8,120}$'),
  constraint generation_attempts_provider check (provider = 'muse'),
  constraint generation_attempts_fingerprint check (selection_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint generation_attempts_status check (status in ('reserved', 'request_started', 'saved', 'failed_before_request', 'reconciliation_required')),
  constraint generation_attempts_credit_state check (credit_state in ('reserved', 'consumed', 'released', 'reconciliation_required')),
  constraint generation_attempts_result_path check (result_path is null or result_path ~ '^results/run-[A-Za-z0-9-]{8,120}\.png$')
);

create index if not exists generation_attempts_user_project_idx on public.generation_attempts(user_id, project_id, created_at desc);

create table if not exists public.billing_events (
  stripe_event_id text primary key,
  event_type text not null,
  payload_sha256 text not null,
  status text not null default 'processing',
  attempts integer not null default 1,
  error_code text,
  event_created bigint,
  first_received_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint billing_events_id check (stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
  constraint billing_events_sha check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  constraint billing_events_status check (status in ('processing', 'completed', 'failed')),
  constraint billing_events_attempts check (attempts between 1 and 20)
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  event_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_user_created_idx on public.audit_events(user_id, created_at desc);

create table if not exists public.auth_otp_challenges (
  email_hash text primary key,
  mode text not null default 'signup',
  requested_at timestamptz not null default now(),
  attempts integer not null default 0,
  consumed_at timestamptz,
  constraint auth_otp_hash check (email_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_otp_mode check (mode in ('signup', 'login')),
  constraint auth_otp_attempts check (attempts between 0 and 5)
);

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.assets enable row level security;
alter table public.plans enable row level security;
alter table public.billing_customers enable row level security;
alter table public.billing_checkout_intents enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_periods enable row level security;
alter table public.generation_attempts enable row level security;
alter table public.billing_events enable row level security;
alter table public.audit_events enable row level security;
alter table public.auth_otp_challenges enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using (auth.uid() = user_id);
drop policy if exists projects_select_own on public.projects;
create policy projects_select_own on public.projects for select to authenticated using (auth.uid() = owner_id);
drop policy if exists assets_select_own on public.assets;
create policy assets_select_own on public.assets for select to authenticated using (auth.uid() = owner_id);
drop policy if exists plans_select_active on public.plans;
create policy plans_select_active on public.plans for select to anon, authenticated using (active);
drop policy if exists billing_customers_select_own on public.billing_customers;
create policy billing_customers_select_own on public.billing_customers for select to authenticated using (auth.uid() = user_id);
drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions for select to authenticated using (auth.uid() = user_id);
drop policy if exists usage_periods_select_own on public.usage_periods;
create policy usage_periods_select_own on public.usage_periods for select to authenticated using (auth.uid() = user_id);
drop policy if exists generation_attempts_select_own on public.generation_attempts;
create policy generation_attempts_select_own on public.generation_attempts for select to authenticated using (auth.uid() = user_id);
drop policy if exists audit_events_select_own on public.audit_events;
create policy audit_events_select_own on public.audit_events for select to authenticated using (auth.uid() = user_id);

revoke all on public.billing_events from anon, authenticated;
revoke all on public.billing_checkout_intents from anon, authenticated;
revoke all on public.auth_otp_challenges from anon, authenticated;
grant select on public.plans to anon, authenticated;
grant select on public.profiles, public.projects, public.assets, public.billing_customers, public.subscriptions, public.usage_periods, public.generation_attempts, public.audit_events to authenticated;
grant all on public.profiles, public.projects, public.assets, public.plans, public.billing_customers, public.billing_checkout_intents, public.subscriptions, public.usage_periods, public.generation_attempts, public.billing_events, public.audit_events, public.auth_otp_challenges to service_role;

create or replace function public.begin_otp_challenge(p_email_hash text, p_mode text default 'signup')
returns table(allowed boolean, retry_after_seconds integer, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  challenge public.auth_otp_challenges%rowtype;
  retry_seconds integer;
begin
  if p_email_hash !~ '^[a-f0-9]{64}$' or p_mode not in ('signup', 'login') then
    raise exception 'invalid_otp_challenge';
  end if;

  -- The advisory lock also covers the first request, before a row exists.  This
  -- makes the 60-second throttle atomic under concurrent serverless invocations.
  perform pg_advisory_xact_lock(hashtextextended(p_email_hash, 42061));
  select * into challenge
  from public.auth_otp_challenges
  where email_hash = p_email_hash
  for update;

  if not found then
    insert into public.auth_otp_challenges(email_hash, mode, requested_at, attempts, consumed_at)
    values (p_email_hash, p_mode, now(), 0, null);
    return query select true, 0, 'allowed'::text;
    return;
  end if;

  if challenge.requested_at > now() - interval '60 seconds' then
    retry_seconds := greatest(1, ceil(extract(epoch from (challenge.requested_at + interval '60 seconds' - now())))::integer);
    return query select false, retry_seconds, 'cooldown'::text;
    return;
  end if;

  -- A resend during the same 15-minute challenge keeps the failed-attempt
  -- counter.  Otherwise repeatedly requesting mail would bypass the 5-try cap.
  if challenge.consumed_at is null and challenge.requested_at >= now() - interval '15 minutes' then
    if challenge.attempts >= 5 then
      retry_seconds := greatest(1, ceil(extract(epoch from (challenge.requested_at + interval '15 minutes' - now())))::integer);
      return query select false, retry_seconds, 'attempts_exhausted'::text;
      return;
    end if;
    update public.auth_otp_challenges
    set mode = p_mode, requested_at = now()
    where email_hash = p_email_hash;
  else
    update public.auth_otp_challenges
    set mode = p_mode, requested_at = now(), attempts = 0, consumed_at = null
    where email_hash = p_email_hash;
  end if;

  return query select true, 0, 'allowed'::text;
end;
$$;

create or replace function public.consume_otp_attempt(p_email_hash text)
returns table(allowed boolean, attempts_remaining integer, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  challenge public.auth_otp_challenges%rowtype;
begin
  select * into challenge from public.auth_otp_challenges where email_hash = p_email_hash for update;
  if not found then return query select false, 0, 'missing'::text; return; end if;
  if challenge.consumed_at is not null then return query select false, 0, 'consumed'::text; return; end if;
  if challenge.requested_at < now() - interval '15 minutes' then return query select false, 0, 'expired'::text; return; end if;
  if challenge.attempts >= 5 then return query select false, 0, 'attempts_exhausted'::text; return; end if;
  update public.auth_otp_challenges set attempts = attempts + 1 where email_hash = p_email_hash;
  return query select true, greatest(0, 4 - challenge.attempts), 'allowed'::text;
end;
$$;

create or replace function public.complete_otp_challenge(p_email_hash text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.auth_otp_challenges set consumed_at = now() where email_hash = p_email_hash;
$$;

create or replace function public.begin_billing_checkout(
  p_user_id uuid,
  p_plan_code text,
  p_billing_interval text,
  p_stripe_price_id text,
  p_return_path text,
  p_replace_session_id text default null
)
returns table(
  checkout_action text,
  checkout_intent_id uuid,
  selected_plan_code text,
  selected_billing_interval text,
  selected_stripe_price_id text,
  selected_return_path text,
  checkout_session_id text,
  checkout_session_url text,
  checkout_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_intent public.billing_checkout_intents%rowtype;
  new_intent_id uuid;
begin
  if p_user_id is null or p_plan_code not in ('essential', 'pro') or p_billing_interval not in ('month', 'year')
    or p_stripe_price_id !~ '^price_[A-Za-z0-9]+$' then
    raise exception 'invalid_checkout_intent';
  end if;
  if p_return_path is null
    or char_length(p_return_path) > 273
    or (p_return_path <> '/studio.html' and left(p_return_path, 13) <> '/studio.html?')
    or position(chr(92) in p_return_path) > 0
    or p_return_path ~ '[[:cntrl:]]' then
    raise exception 'invalid_checkout_return_path';
  end if;
  if p_replace_session_id is not null and p_replace_session_id !~ '^cs_(test|live)_[A-Za-z0-9]+$' then
    raise exception 'invalid_checkout_session';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 42062));

  -- An `active` row whose local Stripe period is no longer current is not
  -- sufficient evidence that the remote subscription ended: a renewal webhook
  -- may simply be late.  The API must retrieve that subscription from Stripe
  -- and sync it before this RPC is called again.  Keeping this explicit also
  -- preserves the one-live-subscription unique index.
  if exists(
    select 1 from public.subscriptions s
    where s.user_id = p_user_id
      and s.status = 'active'
      and (
        s.current_period_start is null
        or s.current_period_start > now()
        or s.current_period_end is null
        or s.current_period_end <= now()
      )
  ) then
    return query select 'subscription_reconciliation_required'::text, null::uuid, null::text, null::text, null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if exists(
    select 1 from public.subscriptions s
    where s.user_id = p_user_id
      and s.status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused')
  ) then
    return query select 'subscription_exists'::text, null::uuid, null::text, null::text, null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  select * into current_intent
  from public.billing_checkout_intents b
  where b.user_id = p_user_id
  for update;

  if found and current_intent.status = 'creating' then
    if current_intent.plan_code = p_plan_code
      and current_intent.billing_interval = p_billing_interval
      and current_intent.stripe_price_id = p_stripe_price_id then
      -- Reuse the same intent (and therefore the same Stripe idempotency key),
      -- including after a lost HTTP response.
      update public.billing_checkout_intents
      set lease_expires_at = now() + interval '2 minutes', updated_at = now()
      where user_id = p_user_id;
      return query select 'create'::text, current_intent.intent_id, current_intent.plan_code, current_intent.billing_interval, current_intent.stripe_price_id,
        current_intent.return_path, current_intent.stripe_checkout_session_id, current_intent.checkout_url, current_intent.expires_at;
      return;
    end if;

    if current_intent.lease_expires_at > now() then
      return query select 'creating_other_offer'::text, current_intent.intent_id, current_intent.plan_code, current_intent.billing_interval, current_intent.stripe_price_id,
        current_intent.return_path, current_intent.stripe_checkout_session_id, current_intent.checkout_url, current_intent.expires_at;
      return;
    end if;

    -- No Stripe session was ever attached and the creator lease elapsed.  It is
    -- now safe to abandon this pre-session intent and create a fresh immutable
    -- intent for the newly selected offer below.
    update public.billing_checkout_intents
    set status = 'failed', updated_at = now()
    where user_id = p_user_id;
  end if;

  if found and current_intent.status = 'cancelling' then
    if current_intent.lease_expires_at <= now() and p_replace_session_id = current_intent.stripe_checkout_session_id then
      update public.billing_checkout_intents
      set lease_expires_at = now() + interval '2 minutes', updated_at = now()
      where user_id = p_user_id;
      return query select 'expire'::text, current_intent.intent_id, current_intent.plan_code, current_intent.billing_interval, current_intent.stripe_price_id,
        current_intent.return_path, current_intent.stripe_checkout_session_id, current_intent.checkout_url, current_intent.expires_at;
      return;
    end if;
    return query select 'busy'::text, current_intent.intent_id, current_intent.plan_code, current_intent.billing_interval, current_intent.stripe_price_id,
      current_intent.return_path, null::text, null::text, current_intent.expires_at;
    return;
  end if;

  if found and current_intent.status = 'open' and current_intent.expires_at > now() then
    if current_intent.plan_code = p_plan_code and current_intent.billing_interval = p_billing_interval then
      return query select 'resume'::text, current_intent.intent_id, current_intent.plan_code, current_intent.billing_interval, current_intent.stripe_price_id,
        current_intent.return_path, current_intent.stripe_checkout_session_id, current_intent.checkout_url, current_intent.expires_at;
      return;
    end if;
    if p_replace_session_id = current_intent.stripe_checkout_session_id then
      update public.billing_checkout_intents
      set status = 'cancelling', lease_expires_at = now() + interval '2 minutes', updated_at = now()
      where user_id = p_user_id;
      return query select 'expire'::text, current_intent.intent_id, current_intent.plan_code, current_intent.billing_interval, current_intent.stripe_price_id,
        current_intent.return_path, current_intent.stripe_checkout_session_id, current_intent.checkout_url, current_intent.expires_at;
      return;
    end if;
    return query select 'open_other_offer'::text, current_intent.intent_id, current_intent.plan_code, current_intent.billing_interval, current_intent.stripe_price_id,
      current_intent.return_path, current_intent.stripe_checkout_session_id, current_intent.checkout_url, current_intent.expires_at;
    return;
  end if;

  if found and current_intent.status = 'completed' then
    return query select 'subscription_pending'::text, current_intent.intent_id, current_intent.plan_code, current_intent.billing_interval, current_intent.stripe_price_id,
      current_intent.return_path, current_intent.stripe_checkout_session_id, null::text, current_intent.expires_at;
    return;
  end if;

  if found and current_intent.status = 'open' then
    update public.billing_checkout_intents set status = 'expired', updated_at = now() where user_id = p_user_id;
  end if;

  new_intent_id := gen_random_uuid();
  insert into public.billing_checkout_intents(
    user_id, intent_id, plan_code, billing_interval, stripe_price_id, return_path, status,
    stripe_checkout_session_id, checkout_url, expires_at, lease_expires_at,
    stripe_event_created, created_at, updated_at
  ) values (
    p_user_id, new_intent_id, p_plan_code, p_billing_interval, p_stripe_price_id, p_return_path, 'creating',
    null, null, null, now() + interval '2 minutes', 0, now(), now()
  )
  on conflict (user_id) do update set
    intent_id = excluded.intent_id,
    plan_code = excluded.plan_code,
    billing_interval = excluded.billing_interval,
    stripe_price_id = excluded.stripe_price_id,
    return_path = excluded.return_path,
    status = 'creating',
    stripe_checkout_session_id = null,
    checkout_url = null,
    expires_at = null,
    lease_expires_at = excluded.lease_expires_at,
    stripe_event_created = 0,
    created_at = now(),
    updated_at = now();

  return query select 'create'::text, new_intent_id, p_plan_code, p_billing_interval, p_stripe_price_id, p_return_path,
    null::text, null::text, null::timestamptz;
end;
$$;

create or replace function public.attach_billing_checkout_session(
  p_user_id uuid,
  p_intent_id uuid,
  p_session_id text,
  p_checkout_url text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_intent public.billing_checkout_intents%rowtype;
begin
  if p_session_id !~ '^cs_(test|live)_[A-Za-z0-9]+$'
    or p_checkout_url !~ '^https://checkout\.stripe\.com/[^[:space:]]{1,3900}$'
    or p_expires_at <= now() then
    raise exception 'invalid_checkout_session';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 42062));
  select * into current_intent from public.billing_checkout_intents where user_id = p_user_id for update;
  if not found or current_intent.intent_id <> p_intent_id then return false; end if;
  if current_intent.status = 'open' and current_intent.stripe_checkout_session_id = p_session_id then return true; end if;
  if current_intent.status <> 'creating' or current_intent.stripe_checkout_session_id is not null then return false; end if;
  update public.billing_checkout_intents
  set status = 'open', stripe_checkout_session_id = p_session_id, checkout_url = p_checkout_url,
      expires_at = p_expires_at, lease_expires_at = p_expires_at, updated_at = now()
  where user_id = p_user_id and intent_id = p_intent_id;
  return true;
end;
$$;

create or replace function public.finish_billing_checkout_replacement(
  p_user_id uuid,
  p_intent_id uuid,
  p_session_id text,
  p_terminal_status text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_intent public.billing_checkout_intents%rowtype;
begin
  if p_terminal_status not in ('expired', 'cancelled', 'completed') then raise exception 'invalid_checkout_status'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 42062));
  select * into current_intent from public.billing_checkout_intents where user_id = p_user_id for update;
  if not found or current_intent.intent_id <> p_intent_id or current_intent.stripe_checkout_session_id <> p_session_id then return false; end if;
  if current_intent.status = 'completed' then return p_terminal_status = 'completed'; end if;
  update public.billing_checkout_intents
  set status = p_terminal_status, updated_at = now()
  where user_id = p_user_id and intent_id = p_intent_id;
  return true;
end;
$$;

create or replace function public.record_billing_checkout_event(
  p_session_id text,
  p_status text,
  p_event_created bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_session_id !~ '^cs_(test|live)_[A-Za-z0-9]+$' or p_status not in ('completed', 'expired', 'failed') or p_event_created < 1 then
    raise exception 'invalid_checkout_event';
  end if;
  update public.billing_checkout_intents
  set status = p_status, stripe_event_created = p_event_created, updated_at = now()
  where stripe_checkout_session_id = p_session_id
    and p_event_created >= stripe_event_created
    and not (status = 'completed' and p_status = 'expired');
end;
$$;

create or replace function public.complete_client_onboarding(
  p_first_name text,
  p_last_name text,
  p_company_name text,
  p_phone text,
  p_terms_version text,
  p_project_name text,
  p_property_type text,
  p_city text,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  existing_project_id uuid;
  new_project_id uuid;
begin
  if current_user_id is null then raise exception 'authentication_required'; end if;
  if coalesce(char_length(trim(p_first_name)), 0) not between 1 and 80 or coalesce(char_length(trim(p_last_name)), 0) not between 1 and 80 then raise exception 'invalid_profile'; end if;
  if coalesce(char_length(trim(p_project_name)), 0) not between 2 and 100 or coalesce(p_property_type, '') not in ('apartment', 'house', 'studio', 'other') then raise exception 'invalid_project'; end if;
  if coalesce(char_length(p_terms_version), 0) < 1 then raise exception 'terms_required'; end if;

  select id into existing_project_id from public.projects where owner_id = current_user_id and status = 'active' order by created_at asc limit 1;
  insert into public.profiles(user_id, first_name, last_name, company_name, phone, signup_mode, onboarding_completed_at, terms_version, terms_accepted_at, updated_at)
  values (current_user_id, trim(p_first_name), trim(p_last_name), nullif(trim(coalesce(p_company_name, '')), ''), nullif(trim(coalesce(p_phone, '')), ''), 'public_otp', now(), p_terms_version, now(), now())
  on conflict (user_id) do update set
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    company_name = excluded.company_name,
    phone = excluded.phone,
    onboarding_completed_at = coalesce(public.profiles.onboarding_completed_at, excluded.onboarding_completed_at),
    terms_version = excluded.terms_version,
    terms_accepted_at = excluded.terms_accepted_at,
    updated_at = now();

  if existing_project_id is not null then return existing_project_id; end if;
  insert into public.projects(owner_id, name, property_type, city, notes)
  values (current_user_id, trim(p_project_name), p_property_type, nullif(trim(coalesce(p_city, '')), ''), nullif(trim(coalesce(p_notes, '')), ''))
  returning id into new_project_id;
  return new_project_id;
end;
$$;

create or replace function public.create_client_project(p_name text, p_property_type text, p_city text, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  new_project_id uuid;
begin
  if current_user_id is null then raise exception 'authentication_required'; end if;
  if not exists(select 1 from public.profiles where user_id = current_user_id and onboarding_completed_at is not null) then raise exception 'onboarding_required'; end if;
  if (select count(*) from public.projects where owner_id = current_user_id and status = 'active') >= 100 then raise exception 'project_limit_reached'; end if;
  if coalesce(char_length(trim(p_name)), 0) not between 2 and 100 or coalesce(p_property_type, '') not in ('apartment', 'house', 'studio', 'other') then raise exception 'invalid_project'; end if;
  insert into public.projects(owner_id, name, property_type, city, notes)
  values (current_user_id, trim(p_name), p_property_type, nullif(trim(coalesce(p_city, '')), ''), nullif(trim(coalesce(p_notes, '')), ''))
  returning id into new_project_id;
  return new_project_id;
end;
$$;

create or replace function public.claim_billing_event(p_event_id text, p_event_type text, p_payload_sha256 text, p_event_created bigint)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.billing_events%rowtype;
begin
  select * into existing from public.billing_events where stripe_event_id = p_event_id for update;
  if not found then
    insert into public.billing_events(stripe_event_id, event_type, payload_sha256, event_created)
    values (p_event_id, p_event_type, p_payload_sha256, p_event_created);
    return 'claimed';
  end if;
  if existing.payload_sha256 <> p_payload_sha256 or existing.event_type <> p_event_type then return 'conflict'; end if;
  if existing.status = 'completed' then return 'completed'; end if;
  if existing.status = 'processing' and existing.last_attempt_at > now() - interval '5 minutes' then return 'processing'; end if;
  if existing.attempts >= 20 then return 'exhausted'; end if;
  update public.billing_events set status = 'processing', attempts = attempts + 1, error_code = null, last_attempt_at = now() where stripe_event_id = p_event_id;
  return 'claimed';
end;
$$;

create or replace function public.finish_billing_event(p_event_id text, p_success boolean, p_error_code text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.billing_events
  set status = case when p_success then 'completed' else 'failed' end,
      error_code = case when p_success then null else left(coalesce(p_error_code, 'processing_failed'), 100) end,
      completed_at = case when p_success then now() else null end,
      last_attempt_at = now()
  where stripe_event_id = p_event_id;
$$;

create or replace function public.sync_stripe_subscription(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_plan_code text,
  p_billing_interval text,
  p_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_latest_invoice_id text,
  p_event_created bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_plan_code not in ('essential', 'pro') or p_billing_interval not in ('month', 'year') then raise exception 'unknown_plan'; end if;
  if p_status not in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused') then raise exception 'invalid_subscription_status'; end if;
  insert into public.billing_customers(user_id, stripe_customer_id, updated_at)
  values (p_user_id, p_customer_id, now())
  on conflict (user_id) do update set stripe_customer_id = excluded.stripe_customer_id, updated_at = now();
  insert into public.subscriptions(user_id, stripe_customer_id, stripe_subscription_id, plan_code, billing_interval, status, current_period_start, current_period_end, cancel_at_period_end, latest_invoice_id, stripe_event_created, updated_at)
  values (p_user_id, p_customer_id, p_subscription_id, p_plan_code, p_billing_interval, p_status, p_period_start, p_period_end, coalesce(p_cancel_at_period_end, false), p_latest_invoice_id, p_event_created, now())
  on conflict (stripe_subscription_id) do update set
    user_id = excluded.user_id,
    stripe_customer_id = excluded.stripe_customer_id,
    plan_code = excluded.plan_code,
    billing_interval = excluded.billing_interval,
    status = excluded.status,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    latest_invoice_id = coalesce(excluded.latest_invoice_id, public.subscriptions.latest_invoice_id),
    stripe_event_created = excluded.stripe_event_created,
    updated_at = now()
  where excluded.stripe_event_created >= public.subscriptions.stripe_event_created;
end;
$$;

create or replace function public.reserve_generation_credit(
  p_user_id uuid,
  p_authorization_id uuid,
  p_execution_id uuid,
  p_run_id text,
  p_project_id uuid,
  p_source_asset_id uuid,
  p_selection_fingerprint text
)
returns table(reservation_status text, remaining_generations integer, attempt_status text, reservation_owned boolean, result_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_subscription public.subscriptions%rowtype;
  current_plan public.plans%rowtype;
  current_period public.usage_periods%rowtype;
  existing_attempt public.generation_attempts%rowtype;
  stale_attempt public.generation_attempts%rowtype;
  period_start timestamptz;
  period_end timestamptz;
  subscription_period_start_utc timestamp without time zone;
  subscription_period_end_utc timestamp without time zone;
  current_time_utc timestamp without time zone := (now() at time zone 'UTC');
  period_candidate_start_utc timestamp without time zone;
  period_candidate_end_utc timestamp without time zone;
  period_month_index integer;
begin
  if p_user_id is null or p_authorization_id is null or p_execution_id is null then raise exception 'invalid_generation_identity'; end if;
  if p_run_id !~ '^run-[A-Za-z0-9-]{8,120}$' or p_selection_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'invalid_generation_identity'; end if;
  if not exists(select 1 from public.projects where id = p_project_id and owner_id = p_user_id and status = 'active') then raise exception 'project_not_found'; end if;
  if not exists(select 1 from public.assets where id = p_source_asset_id and owner_id = p_user_id and project_id = p_project_id and kind = 'source_photo' and deleted_at is null) then raise exception 'source_asset_not_found'; end if;

  -- Serialise the first insert for this client-supplied idempotency key. A
  -- repeated HTTP delivery can therefore only observe the winning attempt.
  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 42063));

  -- A reservation is only a short-lived pre-request lease. If a function dies or
  -- its successful response is lost before Muse starts, the next reservation by
  -- the same client releases leases older than 30 minutes in this transaction.
  -- Attempts are locked before their usage periods, matching the start/release
  -- RPCs and keeping the counter transition atomic under concurrent requests.
  for stale_attempt in
    select g.*
    from public.generation_attempts g
    where g.user_id = p_user_id
      and g.status = 'reserved'
      and g.credit_state = 'reserved'
      and g.request_started_at is null
      and g.updated_at <= now() - interval '30 minutes'
    order by g.authorization_id
    for update
  loop
    update public.usage_periods
    set reserved_generations = greatest(0, reserved_generations - 1), updated_at = now()
    where id = stale_attempt.usage_period_id;
    update public.generation_attempts
    set status = 'failed_before_request',
        credit_state = 'released',
        failure_code = 'reservation_ttl_expired',
        updated_at = now()
    where authorization_id = stale_attempt.authorization_id;
    insert into public.audit_events(user_id, project_id, event_type, entity_id, details)
    values (
      p_user_id,
      stale_attempt.project_id,
      'generation.credit_released',
      stale_attempt.authorization_id::text,
      jsonb_build_object('reason', 'reservation_ttl_expired', 'ttl_seconds', 1800)
    );
  end loop;

  select * into existing_attempt from public.generation_attempts where authorization_id = p_authorization_id;
  if found then
    if existing_attempt.user_id <> p_user_id or existing_attempt.run_id <> p_run_id or existing_attempt.project_id <> p_project_id or existing_attempt.source_asset_id <> p_source_asset_id or existing_attempt.selection_fingerprint <> p_selection_fingerprint then
      raise exception 'authorization_conflict';
    end if;
    select * into current_period from public.usage_periods where id = existing_attempt.usage_period_id;
    return query select 'existing'::text,
      greatest(0, coalesce(current_period.included_generations, 0) - coalesce(current_period.reserved_generations, 0) - coalesce(current_period.consumed_generations, 0)),
      existing_attempt.status,
      existing_attempt.reservation_owner_id = p_execution_id,
      existing_attempt.result_path;
    return;
  end if;

  select s.* into current_subscription
  from public.subscriptions s
  where s.user_id = p_user_id
    and s.status = 'active'
    and s.current_period_start is not null
    and s.current_period_start <= now()
    and s.current_period_end is not null
    and s.current_period_end > now()
  order by s.updated_at desc
  limit 1;
  if not found then raise exception 'subscription_required'; end if;
  select * into current_plan from public.plans where code = current_subscription.plan_code and active;
  if not found then raise exception 'plan_unavailable'; end if;

  subscription_period_start_utc := current_subscription.current_period_start at time zone 'UTC';
  subscription_period_end_utc := current_subscription.current_period_end at time zone 'UTC';
  if current_subscription.billing_interval = 'month' then
    -- Monthly credits follow the exact Stripe billing-period boundaries instead
    -- of the server's calendar month.
    period_start := current_subscription.current_period_start;
    period_end := current_subscription.current_period_end;
  elsif current_subscription.billing_interval = 'year' then
    -- Compute every monthly credit window from the original Stripe anchor. Never
    -- advance the previously-clamped date: 31 Jan -> 29 Feb -> 31 Mar.
    period_month_index :=
      (extract(year from current_time_utc)::integer - extract(year from subscription_period_start_utc)::integer) * 12
      + extract(month from current_time_utc)::integer - extract(month from subscription_period_start_utc)::integer;
    period_candidate_start_utc := subscription_period_start_utc + make_interval(months => period_month_index);
    if period_candidate_start_utc > current_time_utc then
      period_month_index := period_month_index - 1;
      period_candidate_start_utc := subscription_period_start_utc + make_interval(months => period_month_index);
    end if;
    if period_month_index < 0 then raise exception 'invalid_subscription_period'; end if;
    period_candidate_end_utc := least(
      subscription_period_start_utc + make_interval(months => period_month_index + 1),
      subscription_period_end_utc
    );
    period_start := period_candidate_start_utc at time zone 'UTC';
    period_end := period_candidate_end_utc at time zone 'UTC';
  else
    raise exception 'invalid_subscription_period';
  end if;
  if period_end <= period_start then raise exception 'invalid_subscription_period'; end if;

  insert into public.usage_periods(user_id, subscription_id, month_start, month_end, included_generations)
  values (p_user_id, current_subscription.id, period_start, period_end, current_plan.credits_per_month)
  on conflict (subscription_id, month_start) do update set
    included_generations = greatest(public.usage_periods.included_generations, excluded.included_generations),
    updated_at = now();

  select * into current_period
  from public.usage_periods
  where subscription_id = current_subscription.id and month_start = period_start
  for update;
  if current_period.reserved_generations + current_period.consumed_generations >= current_period.included_generations then raise exception 'credits_exhausted'; end if;

  update public.usage_periods set reserved_generations = reserved_generations + 1, updated_at = now() where id = current_period.id;
  insert into public.generation_attempts(authorization_id, run_id, user_id, project_id, source_asset_id, usage_period_id, selection_fingerprint, reservation_owner_id)
  values (p_authorization_id, p_run_id, p_user_id, p_project_id, p_source_asset_id, current_period.id, p_selection_fingerprint, p_execution_id);
  insert into public.audit_events(user_id, project_id, event_type, entity_id)
  values (p_user_id, p_project_id, 'generation.credit_reserved', p_authorization_id::text);
  return query select 'reserved'::text,
    current_period.included_generations - current_period.reserved_generations - current_period.consumed_generations - 1,
    'reserved'::text,
    true,
    null::text;
end;
$$;

create or replace function public.mark_generation_request_started(p_user_id uuid, p_authorization_id uuid, p_execution_id uuid)
returns table(claim_status text, credit_status text, attempt_status text, result_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempt public.generation_attempts%rowtype;
begin
  if p_user_id is null or p_authorization_id is null or p_execution_id is null then raise exception 'invalid_generation_identity'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 42064));
  select * into current_attempt from public.generation_attempts where authorization_id = p_authorization_id and user_id = p_user_id for update;
  if not found then raise exception 'generation_attempt_not_found'; end if;
  if current_attempt.status = 'saved' then return query select 'saved'::text, current_attempt.credit_state, current_attempt.status, current_attempt.result_path; return; end if;
  if current_attempt.status = 'reconciliation_required' then return query select 'reconciliation_required'::text, current_attempt.credit_state, current_attempt.status, current_attempt.result_path; return; end if;
  if current_attempt.status = 'failed_before_request' then return query select 'closed'::text, current_attempt.credit_state, current_attempt.status, current_attempt.result_path; return; end if;
  if current_attempt.status = 'request_started' then
    return query select case when current_attempt.execution_id = p_execution_id then 'already_started' else 'in_progress' end,
      current_attempt.credit_state, current_attempt.status, current_attempt.result_path;
    return;
  end if;
  if current_attempt.credit_state <> 'reserved' or current_attempt.status <> 'reserved' then raise exception 'generation_attempt_not_startable'; end if;
  if current_attempt.reservation_owner_id <> p_execution_id then
    return query select 'in_progress'::text, current_attempt.credit_state, current_attempt.status, current_attempt.result_path;
    return;
  end if;
  if exists (
    select 1 from public.generation_attempts g
    where g.user_id = p_user_id
      and g.authorization_id <> p_authorization_id
      and g.status in ('request_started', 'reconciliation_required')
  ) then
    return query select 'in_progress'::text, current_attempt.credit_state, current_attempt.status, current_attempt.result_path;
    return;
  end if;
  update public.usage_periods set reserved_generations = reserved_generations - 1, consumed_generations = consumed_generations + 1, updated_at = now()
  where id = current_attempt.usage_period_id and reserved_generations > 0;
  if not found then raise exception 'credit_reservation_missing'; end if;
  update public.generation_attempts set status = 'request_started', credit_state = 'consumed', execution_id = p_execution_id, request_started_at = now(), updated_at = now()
  where authorization_id = p_authorization_id;
  insert into public.audit_events(user_id, project_id, event_type, entity_id)
  values (p_user_id, current_attempt.project_id, 'generation.request_started', p_authorization_id::text);
  return query select 'started'::text, 'consumed'::text, 'request_started'::text, null::text;
end;
$$;

create or replace function public.release_generation_credit(p_user_id uuid, p_authorization_id uuid, p_execution_id uuid, p_reason text default 'failed_before_request')
returns table(release_status text, credit_status text, attempt_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempt public.generation_attempts%rowtype;
begin
  if p_user_id is null or p_authorization_id is null or p_execution_id is null then raise exception 'invalid_generation_identity'; end if;
  select * into current_attempt from public.generation_attempts where authorization_id = p_authorization_id and user_id = p_user_id for update;
  if not found then raise exception 'generation_attempt_not_found'; end if;
  if current_attempt.credit_state = 'released' then return query select 'already_released'::text, 'released'::text, current_attempt.status; return; end if;
  if current_attempt.credit_state <> 'reserved' or current_attempt.request_started_at is not null then
    return query select 'not_releasable'::text, current_attempt.credit_state, current_attempt.status; return;
  end if;
  if current_attempt.reservation_owner_id <> p_execution_id then
    return query select 'not_owner'::text, current_attempt.credit_state, current_attempt.status; return;
  end if;
  update public.usage_periods set reserved_generations = reserved_generations - 1, updated_at = now()
  where id = current_attempt.usage_period_id and reserved_generations > 0;
  if not found then raise exception 'credit_reservation_missing'; end if;
  update public.generation_attempts set status = 'failed_before_request', credit_state = 'released', failure_code = left(coalesce(p_reason, 'failed_before_request'), 100), updated_at = now()
  where authorization_id = p_authorization_id;
  insert into public.audit_events(user_id, project_id, event_type, entity_id, details)
  values (p_user_id, current_attempt.project_id, 'generation.credit_released', p_authorization_id::text, jsonb_build_object('reason', left(coalesce(p_reason, 'failed_before_request'), 100)));
  return query select 'released'::text, 'released'::text, 'failed_before_request'::text;
end;
$$;

create or replace function public.finish_generation_attempt(p_user_id uuid, p_authorization_id uuid, p_execution_id uuid, p_outcome text, p_result_path text default null)
returns table(finish_status text, credit_status text, attempt_status text, result_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempt public.generation_attempts%rowtype;
begin
  if p_user_id is null or p_authorization_id is null or p_execution_id is null then raise exception 'invalid_generation_identity'; end if;
  if p_outcome not in ('saved', 'reconciliation_required') then raise exception 'invalid_generation_outcome'; end if;
  select * into current_attempt from public.generation_attempts where authorization_id = p_authorization_id and user_id = p_user_id for update;
  if not found then raise exception 'generation_attempt_not_found'; end if;
  if current_attempt.status = 'saved' then
    if p_outcome = 'saved' and p_result_path is distinct from current_attempt.result_path then raise exception 'authorization_conflict'; end if;
    return query select 'already_saved'::text, 'consumed'::text, 'saved'::text, current_attempt.result_path;
    return;
  end if;
  if current_attempt.status = 'reconciliation_required' and p_outcome = 'reconciliation_required' then
    return query select 'already_reconciliation_required'::text, 'reconciliation_required'::text, 'reconciliation_required'::text, current_attempt.result_path;
    return;
  end if;
  if current_attempt.execution_id is distinct from p_execution_id then
    return query select 'not_owner'::text, current_attempt.credit_state, current_attempt.status, current_attempt.result_path;
    return;
  end if;
  if current_attempt.credit_state not in ('consumed', 'reconciliation_required') or current_attempt.request_started_at is null then raise exception 'generation_request_not_started'; end if;
  if p_outcome = 'saved' and (p_result_path is null or p_result_path !~ '^results/run-[A-Za-z0-9-]{8,120}\.png$') then raise exception 'invalid_result_path'; end if;
  update public.generation_attempts as g set
    status = p_outcome,
    credit_state = case when p_outcome = 'saved' then 'consumed' else 'reconciliation_required' end,
    result_path = case when p_outcome = 'saved' then p_result_path else g.result_path end,
    updated_at = now()
  where g.authorization_id = p_authorization_id;
  insert into public.audit_events(user_id, project_id, event_type, entity_id)
  values (p_user_id, current_attempt.project_id, 'generation.' || p_outcome, p_authorization_id::text);
  return query select p_outcome, case when p_outcome = 'saved' then 'consumed' else 'reconciliation_required' end, p_outcome,
    case when p_outcome = 'saved' then p_result_path else current_attempt.result_path end;
end;
$$;

create or replace function public.delete_owned_source_asset(p_asset_id uuid)
returns table(asset_id uuid, blob_path text, deletion_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  current_asset public.assets%rowtype;
begin
  if current_user_id is null then raise exception 'authentication_required'; end if;
  select a.* into current_asset
  from public.assets a
  where a.id = p_asset_id and a.owner_id = current_user_id and a.kind = 'source_photo'
  for update;
  if not found then
    return query select null::uuid, null::text, 'not_found'::text;
    return;
  end if;
  if current_asset.deleted_at is not null then
    return query select current_asset.id, current_asset.blob_path, 'already_deleted'::text;
    return;
  end if;
  if exists(
    select 1 from public.generation_attempts g
    where g.source_asset_id = current_asset.id
      and not (g.status = 'failed_before_request' and g.credit_state = 'released')
  ) then
    return query select current_asset.id, current_asset.blob_path, 'in_use'::text;
    return;
  end if;
  update public.assets a set deleted_at = now() where a.id = current_asset.id;
  insert into public.audit_events(user_id, project_id, event_type, entity_id)
  values (current_user_id, current_asset.project_id, 'asset.source_deleted', current_asset.id::text);
  return query select current_asset.id, current_asset.blob_path, 'claimed'::text;
end;
$$;

revoke all on function public.begin_otp_challenge(text, text) from public, anon, authenticated;
revoke all on function public.consume_otp_attempt(text) from public, anon, authenticated;
revoke all on function public.complete_otp_challenge(text) from public, anon, authenticated;
revoke all on function public.begin_billing_checkout(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.attach_billing_checkout_session(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.finish_billing_checkout_replacement(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.record_billing_checkout_event(text, text, bigint) from public, anon, authenticated;
revoke all on function public.claim_billing_event(text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.finish_billing_event(text, boolean, text) from public, anon, authenticated;
revoke all on function public.sync_stripe_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, text, bigint) from public, anon, authenticated;
revoke all on function public.complete_client_onboarding(text, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.create_client_project(text, text, text, text) from public, anon;
revoke all on function public.reserve_generation_credit(uuid, uuid, uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.mark_generation_request_started(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_generation_credit(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_generation_attempt(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.delete_owned_source_asset(uuid) from public, anon, authenticated;
grant execute on function public.begin_otp_challenge(text, text) to service_role;
grant execute on function public.consume_otp_attempt(text) to service_role;
grant execute on function public.complete_otp_challenge(text) to service_role;
grant execute on function public.begin_billing_checkout(uuid, text, text, text, text, text) to service_role;
grant execute on function public.attach_billing_checkout_session(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.finish_billing_checkout_replacement(uuid, uuid, text, text) to service_role;
grant execute on function public.record_billing_checkout_event(text, text, bigint) to service_role;
grant execute on function public.claim_billing_event(text, text, text, bigint) to service_role;
grant execute on function public.finish_billing_event(text, boolean, text) to service_role;
grant execute on function public.sync_stripe_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, text, bigint) to service_role;
grant execute on function public.complete_client_onboarding(text, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.create_client_project(text, text, text, text) to authenticated;
grant execute on function public.reserve_generation_credit(uuid, uuid, uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.mark_generation_request_started(uuid, uuid, uuid) to service_role;
grant execute on function public.release_generation_credit(uuid, uuid, uuid, text) to service_role;
grant execute on function public.finish_generation_attempt(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.delete_owned_source_asset(uuid) to authenticated;

commit;
