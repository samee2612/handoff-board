-- Associates an immutable candidate with the checkpoint thread paused for human review.
create table public.handoff_graph_runs (
  handoff_version_id uuid primary key references public.handoff_versions(id) on delete restrict,
  thread_id uuid not null unique,
  created_at timestamptz not null default now()
);

create trigger handoff_graph_runs_immutable
before update or delete on public.handoff_graph_runs
for each row execute function public.prevent_handoff_history_mutation();

alter table public.handoff_graph_runs enable row level security;

grant select, insert on public.handoff_graph_runs to service_role;
