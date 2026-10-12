begin;

-- Uploads happen before Checkout in the client journey, so they need their own
-- bounded allowance. Reservations make the limit atomic across concurrent
-- serverless invocations and expire when a Blob write never completes.
create table if not exists public.source_upload_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  bytes integer not null,
  status text not null default 'reserved',
  asset_id uuid references public.assets(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  completed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_upload_reservations_bytes check (bytes between 1024 and 3700000),
  constraint source_upload_reservations_status check (status in ('reserved', 'completed', 'released')),
  constraint source_upload_reservations_state check (
    (status = 'reserved' and asset_id is null and completed_at is null and released_at is null)
    or (status = 'completed' and asset_id is not null and completed_at is not null and released_at is null)
    or (status = 'released' and asset_id is null and completed_at is null and released_at is not null)
  )
);

create index if not exists source_upload_reservations_user_created_idx
  on public.source_upload_reservations(user_id, created_at desc);
create unique index if not exists source_upload_reservations_asset_unique_idx
  on public.source_upload_reservations(asset_id) where asset_id is not null;

alter table public.source_upload_reservations enable row level security;
revoke all on public.source_upload_reservations from public, anon, authenticated;
grant all on public.source_upload_reservations to service_role;

create or replace function public.reserve_source_upload(p_user_id uuid, p_project_id uuid, p_bytes integer)
returns table(
  reservation_id uuid,
  allowed boolean,
  reason text,
  retry_after_seconds integer,
  uploads_limit integer,
  bytes_limit bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_project public.projects%rowtype;
  live_plan text;
  v_uploads_limit integer := 10;
  v_bytes_limit bigint := 37000000;
  recent_uploads integer := 0;
  recent_bytes bigint := 0;
  concurrent_uploads integer := 0;
  retry_seconds integer := 60;
  new_reservation_id uuid;
begin
  if p_user_id is null or p_project_id is null or p_bytes not between 1024 and 3700000 then
    raise exception 'invalid_source_upload_reservation';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('source-upload:' || p_user_id::text, 93017));

  select p.* into current_project
  from public.projects p
  where p.id = p_project_id and p.owner_id = p_user_id and p.status = 'active'
  for update;
  if not found then raise exception 'project_not_found'; end if;

  update public.source_upload_reservations r
  set status = 'released', released_at = now(), updated_at = now()
  where r.user_id = p_user_id and r.status = 'reserved' and r.expires_at <= now();

  select s.plan_code into live_plan
  from public.subscriptions s
  where s.user_id = p_user_id
    and s.status = 'active'
    and s.current_period_start is not null and s.current_period_start <= now()
    and s.current_period_end is not null and s.current_period_end > now()
  order by s.stripe_event_created desc, s.updated_at desc
  limit 1;

  if live_plan = 'essential' then
    v_uploads_limit := 30;
    v_bytes_limit := 111000000;
  elsif live_plan = 'pro' then
    v_uploads_limit := 150;
    v_bytes_limit := 555000000;
  end if;

  -- Released reservations still count in the 24-hour attempt/bandwidth budget:
  -- malformed uploads must not bypass anti-abuse by failing before Blob storage.
  select count(*)::integer, coalesce(sum(r.bytes), 0)::bigint
  into recent_uploads, recent_bytes
  from public.source_upload_reservations r
  where r.user_id = p_user_id
    and r.created_at > now() - interval '24 hours';

  select count(*)::integer,
    coalesce(greatest(1, ceil(extract(epoch from (min(r.expires_at) - now())))::integer), 60)
  into concurrent_uploads, retry_seconds
  from public.source_upload_reservations r
  where r.user_id = p_user_id and r.status = 'reserved' and r.expires_at > now();

  if concurrent_uploads >= 3 then
    return query select null::uuid, false, 'concurrent_limit'::text, retry_seconds, v_uploads_limit, v_bytes_limit;
    return;
  end if;

  if recent_uploads >= v_uploads_limit or recent_bytes + p_bytes > v_bytes_limit then
    select coalesce(greatest(1, ceil(extract(epoch from (min(r.created_at + interval '24 hours') - now())))::integer), 3600)
    into retry_seconds
    from public.source_upload_reservations r
    where r.user_id = p_user_id
      and r.created_at > now() - interval '24 hours';
    return query select null::uuid, false, 'daily_limit'::text, retry_seconds, v_uploads_limit, v_bytes_limit;
    return;
  end if;

  insert into public.source_upload_reservations(user_id, project_id, bytes)
  values (p_user_id, p_project_id, p_bytes)
  returning id into new_reservation_id;

  return query select new_reservation_id, true, 'allowed'::text, 0, v_uploads_limit, v_bytes_limit;
end;
$$;

create or replace function public.complete_source_upload(
  p_reservation_id uuid,
  p_user_id uuid,
  p_project_id uuid,
  p_blob_path text,
  p_content_type text,
  p_bytes integer,
  p_width integer,
  p_height integer
)
returns table(asset_id uuid, project_id uuid, blob_path text, content_type text, bytes integer, width integer, height integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_reservation public.source_upload_reservations%rowtype;
  current_asset public.assets%rowtype;
begin
  if p_reservation_id is null or p_user_id is null or p_project_id is null
    or p_blob_path is null or p_blob_path !~ '^uploads/[A-Za-z0-9._-]+$'
    or p_content_type is null or p_content_type not in ('image/jpeg', 'image/png', 'image/webp')
    or p_bytes is null or p_bytes not between 1024 and 3700000
    or p_width is null or p_height is null
    or p_width not between 320 and 5000 or p_height not between 320 and 5000
    or p_width::bigint * p_height::bigint > 16000000 then
    raise exception 'invalid_source_upload_metadata';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('source-upload:' || p_user_id::text, 93017));
  select r.* into current_reservation
  from public.source_upload_reservations r
  where r.id = p_reservation_id and r.user_id = p_user_id
  for update;
  if not found then raise exception 'source_upload_reservation_not_found'; end if;

  if current_reservation.status = 'completed' then
    select a.* into current_asset from public.assets a where a.id = current_reservation.asset_id;
    if not found or current_asset.owner_id <> p_user_id or current_asset.project_id <> p_project_id
      or current_asset.blob_path <> p_blob_path or current_asset.content_type <> p_content_type
      or current_asset.bytes <> p_bytes or current_asset.width <> p_width or current_asset.height <> p_height then
      raise exception 'source_upload_completion_conflict';
    end if;
    return query select current_asset.id, current_asset.project_id, current_asset.blob_path, current_asset.content_type,
      current_asset.bytes, current_asset.width, current_asset.height;
    return;
  end if;

  if current_reservation.status <> 'reserved' or current_reservation.expires_at <= now() then
    raise exception 'source_upload_reservation_expired';
  end if;
  if current_reservation.project_id <> p_project_id or current_reservation.bytes <> p_bytes then
    raise exception 'source_upload_reservation_mismatch';
  end if;
  if not exists(
    select 1 from public.projects p
    where p.id = p_project_id and p.owner_id = p_user_id and p.status = 'active'
  ) then raise exception 'project_not_found'; end if;

  insert into public.assets(owner_id, project_id, blob_path, kind, width, height, content_type, bytes)
  values (p_user_id, p_project_id, p_blob_path, 'source_photo', p_width, p_height, p_content_type, p_bytes)
  returning * into current_asset;

  update public.source_upload_reservations r
  set status = 'completed', asset_id = current_asset.id, completed_at = now(), updated_at = now()
  where r.id = current_reservation.id;

  insert into public.audit_events(user_id, project_id, event_type, entity_id, details)
  values (p_user_id, p_project_id, 'asset.source_uploaded', current_asset.id::text,
    jsonb_build_object('bytes', p_bytes, 'width', p_width, 'height', p_height, 'content_type', p_content_type));

  return query select current_asset.id, current_asset.project_id, current_asset.blob_path, current_asset.content_type,
    current_asset.bytes, current_asset.width, current_asset.height;
end;
$$;

create or replace function public.release_source_upload(p_reservation_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  released boolean;
begin
  if p_reservation_id is null or p_user_id is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('source-upload:' || p_user_id::text, 93017));
  update public.source_upload_reservations r
  set status = 'released', released_at = now(), updated_at = now()
  where r.id = p_reservation_id and r.user_id = p_user_id and r.status = 'reserved';
  released := found;
  return released;
end;
$$;

-- Used only after an ambiguous PostgREST response. It proves that the exact
-- reservation and asset were committed before the API returns a recovered 201.
create or replace function public.reconcile_source_upload_completion(
  p_reservation_id uuid,
  p_user_id uuid,
  p_project_id uuid,
  p_blob_path text,
  p_content_type text,
  p_bytes integer,
  p_width integer,
  p_height integer
)
returns table(completion_status text, asset_id uuid, project_id uuid, blob_path text, content_type text, bytes integer, width integer, height integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_reservation public.source_upload_reservations%rowtype;
  current_asset public.assets%rowtype;
begin
  if p_reservation_id is null or p_user_id is null or p_project_id is null
    or p_blob_path is null or p_blob_path !~ '^uploads/[A-Za-z0-9._-]+$'
    or p_content_type is null or p_content_type not in ('image/jpeg', 'image/png', 'image/webp')
    or p_bytes is null or p_bytes not between 1024 and 3700000
    or p_width is null or p_height is null
    or p_width not between 320 and 5000 or p_height not between 320 and 5000
    or p_width::bigint * p_height::bigint > 16000000 then
    raise exception 'invalid_source_upload_metadata';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('source-upload:' || p_user_id::text, 93017));
  select r.* into current_reservation
  from public.source_upload_reservations r
  where r.id = p_reservation_id and r.user_id = p_user_id
  for update;
  if not found then raise exception 'source_upload_reservation_not_found'; end if;
  if current_reservation.project_id <> p_project_id or current_reservation.bytes <> p_bytes then
    raise exception 'source_upload_reservation_mismatch';
  end if;

  if current_reservation.status = 'completed' then
    select a.* into current_asset from public.assets a where a.id = current_reservation.asset_id;
    if not found or current_asset.owner_id <> p_user_id or current_asset.project_id <> p_project_id
      or current_asset.blob_path <> p_blob_path or current_asset.content_type <> p_content_type
      or current_asset.bytes <> p_bytes or current_asset.width <> p_width or current_asset.height <> p_height then
      raise exception 'source_upload_completion_conflict';
    end if;
    return query select 'completed'::text, current_asset.id, current_asset.project_id, current_asset.blob_path,
      current_asset.content_type, current_asset.bytes, current_asset.width, current_asset.height;
    return;
  end if;

  return query select
    case when current_reservation.status = 'reserved' and current_reservation.expires_at <= now() then 'expired'::text else current_reservation.status end,
    null::uuid, current_reservation.project_id, null::text, null::text, current_reservation.bytes, null::integer, null::integer;
end;
$$;

revoke all on function public.reserve_source_upload(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_source_upload(uuid, uuid, uuid, text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.release_source_upload(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reconcile_source_upload_completion(uuid, uuid, uuid, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_source_upload(uuid, uuid, integer) to service_role;
grant execute on function public.complete_source_upload(uuid, uuid, uuid, text, text, integer, integer, integer) to service_role;
grant execute on function public.release_source_upload(uuid, uuid) to service_role;
grant execute on function public.reconcile_source_upload_completion(uuid, uuid, uuid, text, text, integer, integer, integer) to service_role;

commit;
