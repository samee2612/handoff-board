-- Step 4: append-only, explicitly refreshed candidate versions and synthetic-source Realtime.
alter type public.handoff_status add value if not exists 'candidate';

alter table public.handoff_versions
  add column if not exists version_number integer;

with numbered_versions as (
  select id, row_number() over (partition by patient_id order by generated_at, id)::integer as sequence_number
  from public.handoff_versions
)
update public.handoff_versions as version
set version_number = numbered_versions.sequence_number
from numbered_versions
where version.id = numbered_versions.id and version.version_number is null;

alter table public.handoff_versions
  alter column version_number set not null;

create unique index if not exists handoff_versions_patient_version_idx
  on public.handoff_versions(patient_id, version_number);

alter table public.handoff_versions drop constraint if exists handoff_versions_check;
alter table public.handoff_versions add constraint handoff_versions_failure_check check (
  (status = 'failed' and failure_code is not null and failure_message is not null)
  or (status <> 'failed' and failure_code is null and failure_message is null)
);

-- Serializes version allocation per patient and writes the associated evidence and diagnostics atomically.
create or replace function public.append_handoff_version(
  p_id uuid,
  p_patient_id uuid,
  p_source_event_cutoff timestamptz,
  p_status public.handoff_status,
  p_model text,
  p_generated_at timestamptz,
  p_content jsonb,
  p_evidence_gap_count integer,
  p_failure_code text,
  p_failure_message text
)
returns table(version_id uuid, version_number integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version_number integer;
  v_content jsonb;
begin
  if not exists (select 1 from public.patients where id = p_patient_id and is_synthetic) then
    raise exception 'Only synthetic patients may receive handoff versions';
  end if;

  perform 1 from public.patients where id = p_patient_id for update;
  select coalesce(max(h.version_number), 0) + 1 into v_version_number
  from public.handoff_versions h where h.patient_id = p_patient_id;
  v_content := jsonb_set(jsonb_set(p_content, '{id}', to_jsonb(p_id::text)), '{versionNumber}', to_jsonb(v_version_number));

  insert into public.handoff_versions (
    id, patient_id, version_number, source_event_cutoff, status, model, generated_at, content,
    evidence_gap_count, failure_code, failure_message
  ) values (
    p_id, p_patient_id, v_version_number, p_source_event_cutoff, p_status, p_model, p_generated_at, v_content,
    p_evidence_gap_count, p_failure_code, p_failure_message
  );

  insert into public.handoff_claims (handoff_version_id, section, text, evidence_event_ids, verification_status)
  select p_id, claim ->> 'section', claim ->> 'text',
    array(select jsonb_array_elements_text(claim -> 'evidenceEventIds')::uuid), 'supported'
  from jsonb_array_elements(coalesce(v_content -> 'claims', '[]'::jsonb)) as source(claim);

  insert into public.handoff_claims (handoff_version_id, section, text, evidence_event_ids, verification_status)
  select p_id, claim ->> 'section', claim ->> 'text',
    array(select jsonb_array_elements_text(claim -> 'evidenceEventIds')::uuid), 'excluded'
  from jsonb_array_elements(coalesce(v_content -> 'excludedClaims', '[]'::jsonb)) as source(wrapper)
  cross join lateral (select wrapper -> 'claim' as claim) as extracted;

  insert into public.agent_runs (
    handoff_version_id, run_id, agent, status, model, started_at, completed_at, input_event_count, output_count,
    error_code, error_message
  )
  select p_id, (diagnostic ->> 'runId')::uuid, diagnostic ->> 'agent', diagnostic ->> 'status',
    diagnostic ->> 'model', (diagnostic ->> 'startedAt')::timestamptz, (diagnostic ->> 'completedAt')::timestamptz,
    (diagnostic ->> 'inputEventCount')::integer, (diagnostic ->> 'outputCount')::integer,
    diagnostic ->> 'errorCode', diagnostic ->> 'errorMessage'
  from jsonb_array_elements(coalesce(v_content -> 'diagnostics', '[]'::jsonb)) as source(diagnostic);

  return query select p_id, v_version_number;
end;
$$;

revoke all on function public.append_handoff_version(uuid, uuid, timestamptz, public.handoff_status, text, timestamptz, jsonb, integer, text, text) from public, anon, authenticated;
grant execute on function public.append_handoff_version(uuid, uuid, timestamptz, public.handoff_status, text, timestamptz, jsonb, integer, text, text) to service_role;

-- The only public data access is intentionally limited to synthetic source records needed for this demo's Realtime feed.
create policy "synthetic demo units are readable" on public.units for select to anon, authenticated using (
  exists (select 1 from public.patients where patients.unit_id = units.id and patients.is_synthetic)
);
create policy "synthetic demo nurses are readable" on public.nurses for select to anon, authenticated using (
  exists (select 1 from public.patients where patients.assigned_nurse_id = nurses.id and patients.is_synthetic)
);
create policy "synthetic demo patients are readable" on public.patients for select to anon, authenticated using (is_synthetic);
create policy "synthetic demo source events are readable" on public.patient_chart_events for select to anon, authenticated using (
  exists (select 1 from public.patients where patients.id = patient_chart_events.patient_id and patients.is_synthetic)
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'patient_chart_events'
  ) then
    alter publication supabase_realtime add table public.patient_chart_events;
  end if;
end;
$$;
