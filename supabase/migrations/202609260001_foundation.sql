create extension if not exists pgcrypto;

create type public.chart_event_category as enum ('nursing_note', 'vital', 'medication', 'task', 'incident');
create type public.handoff_status as enum ('published', 'failed');
create type public.alert_kind as enum ('scheduled_medication', 'eligible_prn', 'task');
create type public.alert_priority as enum ('overdue', 'imminent');

create table public.units (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.nurses (
  id uuid primary key,
  unit_id uuid not null references public.units(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.patients (
  id uuid primary key,
  unit_id uuid not null references public.units(id) on delete cascade,
  assigned_nurse_id uuid references public.nurses(id),
  is_synthetic boolean not null default true check (is_synthetic),
  display_name text not null,
  room text not null,
  admitted_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.patient_chart_events (
  id uuid primary key,
  patient_id uuid not null references public.patients(id) on delete cascade,
  category public.chart_event_category not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  source_label text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index patient_chart_events_patient_occurred_idx on public.patient_chart_events(patient_id, occurred_at desc);

create table public.handoff_versions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  source_event_cutoff timestamptz not null,
  status public.handoff_status not null default 'published',
  model text not null,
  generated_at timestamptz not null default now(),
  content jsonb not null default '{}'::jsonb,
  evidence_gap_count integer not null default 0 check (evidence_gap_count >= 0),
  failure_code text,
  failure_message text,
  check (
    (status = 'failed' and failure_code is not null and failure_message is not null)
    or (status = 'published' and failure_code is null and failure_message is null)
  )
);

create table public.handoff_claims (
  id uuid primary key default gen_random_uuid(),
  handoff_version_id uuid not null references public.handoff_versions(id) on delete cascade,
  section text not null check (section in ('situation', 'background', 'assessment', 'recommendation')),
  text text not null,
  evidence_event_ids uuid[] not null check (cardinality(evidence_event_ids) > 0),
  verification_status text not null check (verification_status in ('supported', 'excluded', 'gap'))
);

create table public.action_alerts (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  source_event_id uuid not null references public.patient_chart_events(id) on delete cascade,
  kind public.alert_kind not null,
  priority public.alert_priority not null,
  due_at timestamptz not null,
  title text not null,
  created_at timestamptz not null default now()
);

create table public.handoff_reviews (
  id uuid primary key default gen_random_uuid(),
  handoff_version_id uuid not null references public.handoff_versions(id) on delete cascade,
  nurse_id uuid not null references public.nurses(id),
  note text,
  reviewed_at timestamptz not null default now()
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  handoff_version_id uuid not null references public.handoff_versions(id) on delete cascade,
  run_id uuid not null,
  agent text not null check (agent in ('chart_vitals', 'medications', 'tasks_incidents', 'sbar_synthesizer', 'evidence_verifier')),
  status text not null check (status in ('succeeded', 'failed')),
  model text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  input_event_count integer not null check (input_event_count >= 0),
  output_count integer not null check (output_count >= 0),
  error_code text,
  error_message text
);

create function public.prevent_handoff_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Handoff history is append-only';
end;
$$;

create trigger handoff_versions_immutable
before update or delete on public.handoff_versions
for each row execute function public.prevent_handoff_history_mutation();

create trigger handoff_claims_immutable
before update or delete on public.handoff_claims
for each row execute function public.prevent_handoff_history_mutation();

alter table public.units enable row level security;
alter table public.nurses enable row level security;
alter table public.patients enable row level security;
alter table public.patient_chart_events enable row level security;
alter table public.handoff_versions enable row level security;
alter table public.handoff_claims enable row level security;
alter table public.action_alerts enable row level security;
alter table public.handoff_reviews enable row level security;
alter table public.agent_runs enable row level security;

-- The demo has no browser-side data policies. Future authenticated clinical access requires
-- organization-approved RLS policies before any real data connection is considered.
