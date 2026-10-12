begin;

-- A request that reached Muse can only leave reconciliation after an explicit,
-- attributable admin decision.  Both terminal outcomes keep the consumed
-- credit: this migration never turns an ambiguous paid request into a free
-- automatic retry.
alter table public.generation_attempts
  add column if not exists reconciliation_resolution text,
  add column if not exists reconciliation_note text,
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciled_by uuid;

alter table public.generation_attempts
  drop constraint if exists generation_attempts_status;
alter table public.generation_attempts
  add constraint generation_attempts_status check (
    status in ('reserved', 'request_started', 'saved', 'failed_before_request', 'failed_after_request', 'reconciliation_required')
  );

alter table public.generation_attempts
  drop constraint if exists generation_attempts_reconciliation_resolution;
alter table public.generation_attempts
  add constraint generation_attempts_reconciliation_resolution check (
    reconciliation_resolution is null
    or reconciliation_resolution in ('confirmed_saved', 'confirmed_no_result')
  );

alter table public.generation_attempts
  drop constraint if exists generation_attempts_reconciliation_metadata;
alter table public.generation_attempts
  add constraint generation_attempts_reconciliation_metadata check (
    (
      reconciliation_resolution is null
      and reconciliation_note is null
      and reconciled_at is null
      and reconciled_by is null
    )
    or (
      reconciliation_resolution is not null
      and reconciliation_note is not null
      and char_length(reconciliation_note) between 10 and 500
      and reconciled_at is not null
      and reconciled_by is not null
      and (
        (reconciliation_resolution = 'confirmed_saved' and status = 'saved' and credit_state = 'consumed' and result_path is not null)
        or
        (reconciliation_resolution = 'confirmed_no_result' and status = 'failed_after_request' and credit_state = 'consumed' and result_path is null)
      )
    )
  );

alter table public.generation_attempts
  drop constraint if exists generation_attempts_reconciled_by_fkey;
alter table public.generation_attempts
  add constraint generation_attempts_reconciled_by_fkey
  foreign key (reconciled_by) references auth.users(id) on delete restrict;

create or replace function public.resolve_generation_reconciliation(
  p_admin_user_id uuid,
  p_authorization_id uuid,
  p_expected_run_id text,
  p_resolution text,
  p_note text,
  p_result_path text default null,
  p_result_width integer default null,
  p_result_height integer default null,
  p_result_bytes integer default null,
  p_result_content_type text default null
)
returns table(
  resolution_status text,
  attempt_status text,
  credit_status text,
  resolved_result_path text,
  reconciliation_resolved_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempt public.generation_attempts%rowtype;
  current_asset public.assets%rowtype;
  resolution_time timestamptz := now();
  expected_result_path text;
  already_resolved boolean := false;
begin
  if p_admin_user_id is null
    or p_authorization_id is null
    or p_expected_run_id is null
    or p_expected_run_id !~ '^run-[A-Za-z0-9-]{8,120}$'
    or p_resolution is null
    or p_resolution not in ('confirmed_saved', 'confirmed_no_result')
    or p_note is null
    or char_length(trim(p_note)) not between 10 and 500
    or p_note ~ '[[:cntrl:]]' then
    raise exception 'invalid_reconciliation_request';
  end if;
  if not exists(select 1 from auth.users where id = p_admin_user_id) then
    raise exception 'invalid_admin_identity';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 42065));
  select * into current_attempt
  from public.generation_attempts
  where authorization_id = p_authorization_id
  for update;

  if not found then raise exception 'generation_attempt_not_found'; end if;
  if current_attempt.run_id <> p_expected_run_id then raise exception 'authorization_conflict'; end if;

  expected_result_path := 'results/' || current_attempt.run_id || '.png';
  if p_resolution = 'confirmed_saved' and (
    p_result_path is distinct from expected_result_path
    or p_result_width is null or p_result_width not between 320 and 5000
    or p_result_height is null or p_result_height not between 320 and 5000
    or p_result_width::bigint * p_result_height::bigint > 16000000
    or p_result_bytes is null or p_result_bytes not between 1000 and 20000000
    or p_result_content_type is distinct from 'image/png'
  ) then
    raise exception 'invalid_generated_asset_metadata';
  end if;
  if p_resolution = 'confirmed_no_result' and (
    p_result_path is not null
    or p_result_width is not null
    or p_result_height is not null
    or p_result_bytes is not null
    or p_result_content_type is not null
  ) then
    raise exception 'invalid_generated_asset_metadata';
  end if;

  -- Lost admin HTTP responses are idempotent.  A different decision for the
  -- same authorization is rejected instead of rewriting the audit trail.
  if current_attempt.reconciliation_resolution is not null then
    if current_attempt.reconciliation_resolution = p_resolution
      and (p_resolution <> 'confirmed_saved' or current_attempt.result_path = p_result_path) then
      already_resolved := true;
    else
      raise exception 'generation_reconciliation_conflict';
    end if;
  end if;

  if not already_resolved and (
    current_attempt.status <> 'reconciliation_required'
    or current_attempt.credit_state <> 'reconciliation_required'
    or current_attempt.request_started_at is null
  ) then
    raise exception 'generation_not_reconcilable';
  end if;

  -- The result, run record and database asset form one publishable unit.  Blob
  -- bytes are verified by the API before this RPC; the asset is then created or
  -- validated in the same transaction as the terminal generation status.
  if p_resolution = 'confirmed_saved' then
    insert into public.assets(owner_id, project_id, blob_path, kind, width, height, content_type, bytes)
    values (
      current_attempt.user_id,
      current_attempt.project_id,
      p_result_path,
      'generated_result',
      p_result_width,
      p_result_height,
      p_result_content_type,
      p_result_bytes
    )
    on conflict (blob_path) do nothing;

    select * into current_asset
    from public.assets
    where blob_path = p_result_path
    for update;

    if not found
      or current_asset.owner_id <> current_attempt.user_id
      or current_asset.project_id <> current_attempt.project_id
      or current_asset.kind <> 'generated_result'
      or current_asset.width is distinct from p_result_width
      or current_asset.height is distinct from p_result_height
      or current_asset.content_type is distinct from p_result_content_type
      or current_asset.bytes is distinct from p_result_bytes
      or current_asset.deleted_at is not null then
      raise exception 'generated_asset_conflict';
    end if;
  end if;

  if already_resolved then
    return query select
      'already_resolved'::text,
      current_attempt.status,
      current_attempt.credit_state,
      current_attempt.result_path,
      current_attempt.reconciled_at;
    return;
  end if;

  update public.generation_attempts
  set status = case when p_resolution = 'confirmed_saved' then 'saved' else 'failed_after_request' end,
      credit_state = 'consumed',
      result_path = case when p_resolution = 'confirmed_saved' then p_result_path else null end,
      reconciliation_resolution = p_resolution,
      reconciliation_note = trim(p_note),
      reconciled_at = resolution_time,
      reconciled_by = p_admin_user_id,
      updated_at = resolution_time
  where authorization_id = p_authorization_id;

  insert into public.audit_events(user_id, project_id, event_type, entity_id, details)
  values (
    current_attempt.user_id,
    current_attempt.project_id,
    'generation.reconciliation_resolved',
    p_authorization_id::text,
    jsonb_build_object(
      'admin_user_id', p_admin_user_id,
      'run_id', current_attempt.run_id,
      'resolution', p_resolution,
      'note', trim(p_note),
      'previous_status', current_attempt.status,
      'previous_credit_state', current_attempt.credit_state,
      'result_path', case when p_resolution = 'confirmed_saved' then p_result_path else null end,
      'asset_id', case when p_resolution = 'confirmed_saved' then current_asset.id else null end,
      'result_width', case when p_resolution = 'confirmed_saved' then p_result_width else null end,
      'result_height', case when p_resolution = 'confirmed_saved' then p_result_height else null end,
      'result_bytes', case when p_resolution = 'confirmed_saved' then p_result_bytes else null end,
      'result_content_type', case when p_resolution = 'confirmed_saved' then p_result_content_type else null end,
      'provider_call_performed', false
    )
  );

  return query select
    'resolved'::text,
    case when p_resolution = 'confirmed_saved' then 'saved'::text else 'failed_after_request'::text end,
    'consumed'::text,
    case when p_resolution = 'confirmed_saved' then p_result_path else null end,
    resolution_time;
end;
$$;

revoke all on function public.resolve_generation_reconciliation(uuid, uuid, text, text, text, text, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.resolve_generation_reconciliation(uuid, uuid, text, text, text, text, integer, integer, integer, text) to service_role;

commit;
