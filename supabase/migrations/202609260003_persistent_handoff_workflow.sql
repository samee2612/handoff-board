-- Step 1 of the shared workflow: append-only reviews, publication events, and server-only writes.
create type public.handoff_review_action as enum ('reviewed', 'approved', 'rejected');

alter table public.handoff_reviews
  add column action public.handoff_review_action not null default 'reviewed',
  add constraint handoff_reviews_note_length check (note is null or char_length(note) <= 2000);

create table public.handoff_publications (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  handoff_version_id uuid not null unique references public.handoff_versions(id) on delete restrict,
  published_by_nurse_id uuid references public.nurses(id),
  note text,
  published_at timestamptz not null default now(),
  check (note is null or char_length(note) <= 2000)
);

create index handoff_publications_patient_published_idx
  on public.handoff_publications(patient_id, published_at desc, id desc);

create table public.handoff_audit_events (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  handoff_version_id uuid not null references public.handoff_versions(id) on delete restrict,
  nurse_id uuid references public.nurses(id),
  event_type text not null check (event_type in ('review_saved', 'candidate_approved', 'candidate_rejected', 'candidate_published')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index handoff_audit_events_version_created_idx
  on public.handoff_audit_events(handoff_version_id, created_at desc, id desc);

-- Existing seed/published handoffs receive a historical publication record so the latest
-- publication, rather than the largest version number, is the displayed handoff.
insert into public.handoff_publications (patient_id, handoff_version_id, published_by_nurse_id, note, published_at)
select patient_id, id, null, 'Initial synthetic handoff', generated_at
from public.handoff_versions version
where version.status = 'published'
  and not exists (
    select 1 from public.handoff_publications publication where publication.handoff_version_id = version.id
  );

create trigger handoff_reviews_immutable
before update or delete on public.handoff_reviews
for each row execute function public.prevent_handoff_history_mutation();

create trigger handoff_publications_immutable
before update or delete on public.handoff_publications
for each row execute function public.prevent_handoff_history_mutation();

create trigger handoff_audit_events_immutable
before update or delete on public.handoff_audit_events
for each row execute function public.prevent_handoff_history_mutation();

alter table public.handoff_publications enable row level security;
alter table public.handoff_audit_events enable row level security;

-- Every browser-visible row remains restricted to fictional patients. Browser clients receive
-- Realtime inserts only; all writes use the server-side service role through the functions below.
create policy "synthetic demo handoff versions are readable" on public.handoff_versions for select to anon, authenticated using (
  exists (select 1 from public.patients where patients.id = handoff_versions.patient_id and patients.is_synthetic)
);
create policy "synthetic demo handoff reviews are readable" on public.handoff_reviews for select to anon, authenticated using (
  exists (
    select 1 from public.handoff_versions version
    join public.patients patient on patient.id = version.patient_id
    where version.id = handoff_reviews.handoff_version_id and patient.is_synthetic
  )
);
create policy "synthetic demo publications are readable" on public.handoff_publications for select to anon, authenticated using (
  exists (select 1 from public.patients where patients.id = handoff_publications.patient_id and patients.is_synthetic)
);

create or replace function public.record_handoff_review(
  p_handoff_version_id uuid,
  p_nurse_id uuid,
  p_action public.handoff_review_action,
  p_note text
)
returns table(review_id uuid, handoff_version_id uuid, nurse_id uuid, nurse_name text, action public.handoff_review_action, note text, reviewed_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patient_id uuid;
  v_patient_unit_id uuid;
  v_nurse_unit_id uuid;
  v_status public.handoff_status;
  v_review_id uuid;
  v_reviewed_at timestamptz := now();
begin
  select version.patient_id, patient.unit_id, version.status
  into v_patient_id, v_patient_unit_id, v_status
  from public.handoff_versions version
  join public.patients patient on patient.id = version.patient_id
  where version.id = p_handoff_version_id and patient.is_synthetic;

  if v_patient_id is null then
    raise exception 'Only synthetic handoff versions can be reviewed';
  end if;

  select unit_id into v_nurse_unit_id from public.nurses where id = p_nurse_id;
  if v_nurse_unit_id is null or v_nurse_unit_id <> v_patient_unit_id then
    raise exception 'The selected demo nurse is not assigned to this unit';
  end if;

  if p_action <> 'reviewed' and v_status <> 'candidate' then
    raise exception 'Only candidate handoffs can be approved or rejected';
  end if;
  if p_action <> 'reviewed' and exists (
    select 1 from public.handoff_publications publication where publication.handoff_version_id = p_handoff_version_id
  ) then
    raise exception 'A published candidate cannot receive another approval decision';
  end if;
  if p_action = 'rejected' and coalesce(nullif(btrim(p_note), ''), '') = '' then
    raise exception 'A rejection note is required';
  end if;

  insert into public.handoff_reviews (handoff_version_id, nurse_id, action, note, reviewed_at)
  values (p_handoff_version_id, p_nurse_id, p_action, nullif(btrim(p_note), ''), v_reviewed_at)
  returning id into v_review_id;

  insert into public.handoff_audit_events (patient_id, handoff_version_id, nurse_id, event_type, details)
  values (
    v_patient_id,
    p_handoff_version_id,
    p_nurse_id,
    case p_action
      when 'reviewed' then 'review_saved'
      when 'approved' then 'candidate_approved'
      when 'rejected' then 'candidate_rejected'
    end,
    jsonb_build_object('note_present', nullif(btrim(p_note), '') is not null)
  );

  return query
  select review.id, review.handoff_version_id, review.nurse_id, nurse.display_name, review.action, review.note, review.reviewed_at
  from public.handoff_reviews review
  join public.nurses nurse on nurse.id = review.nurse_id
  where review.id = v_review_id;
end;
$$;

create or replace function public.publish_candidate_handoff(
  p_handoff_version_id uuid,
  p_nurse_id uuid,
  p_note text
)
returns table(publication_id uuid, patient_id uuid, handoff_version_id uuid, published_by_nurse_id uuid, note text, published_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patient_id uuid;
  v_patient_unit_id uuid;
  v_nurse_unit_id uuid;
  v_status public.handoff_status;
  v_latest_decision public.handoff_review_action;
  v_publication_id uuid;
  v_published_at timestamptz := now();
begin
  select version.patient_id, patient.unit_id, version.status
  into v_patient_id, v_patient_unit_id, v_status
  from public.handoff_versions version
  join public.patients patient on patient.id = version.patient_id
  where version.id = p_handoff_version_id and patient.is_synthetic
  for update of version;

  if v_patient_id is null or v_status <> 'candidate' then
    raise exception 'Only a synthetic candidate handoff can be published';
  end if;
  if exists (select 1 from public.handoff_publications publication where publication.handoff_version_id = p_handoff_version_id) then
    raise exception 'This candidate has already been published';
  end if;

  select unit_id into v_nurse_unit_id from public.nurses where id = p_nurse_id;
  if v_nurse_unit_id is null or v_nurse_unit_id <> v_patient_unit_id then
    raise exception 'The selected demo nurse is not assigned to this unit';
  end if;

  select action into v_latest_decision
  from public.handoff_reviews
  where handoff_version_id = p_handoff_version_id and action in ('approved', 'rejected')
  order by reviewed_at desc, id desc
  limit 1;
  if v_latest_decision is distinct from 'approved' then
    raise exception 'An approved candidate is required before publishing';
  end if;

  insert into public.handoff_publications (patient_id, handoff_version_id, published_by_nurse_id, note, published_at)
  values (v_patient_id, p_handoff_version_id, p_nurse_id, nullif(btrim(p_note), ''), v_published_at)
  returning id into v_publication_id;

  insert into public.handoff_audit_events (patient_id, handoff_version_id, nurse_id, event_type, details)
  values (v_patient_id, p_handoff_version_id, p_nurse_id, 'candidate_published', jsonb_build_object('note_present', nullif(btrim(p_note), '') is not null));

  return query
  select publication.id, publication.patient_id, publication.handoff_version_id, publication.published_by_nurse_id, publication.note, publication.published_at
  from public.handoff_publications publication
  where publication.id = v_publication_id;
end;
$$;

revoke all on function public.record_handoff_review(uuid, uuid, public.handoff_review_action, text) from public, anon, authenticated;
revoke all on function public.publish_candidate_handoff(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_handoff_review(uuid, uuid, public.handoff_review_action, text) to service_role;
grant execute on function public.publish_candidate_handoff(uuid, uuid, text) to service_role;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'handoff_versions') then
    alter publication supabase_realtime add table public.handoff_versions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'handoff_reviews') then
    alter publication supabase_realtime add table public.handoff_reviews;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'handoff_publications') then
    alter publication supabase_realtime add table public.handoff_publications;
  end if;
end;
$$;
