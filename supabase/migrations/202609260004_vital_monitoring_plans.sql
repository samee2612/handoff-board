-- Synthetic patient-specific monitoring instructions for the vital-sign handoff demo.
create table public.patient_vital_monitoring_plans (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  vital_type text not null check (vital_type in ('blood_pressure', 'heart_rate', 'temperature', 'oxygen_saturation', 'blood_glucose')),
  interval_minutes integer not null check (interval_minutes between 15 and 1440),
  attention_below numeric,
  attention_above numeric,
  urgent_below numeric,
  urgent_above numeric,
  created_at timestamptz not null default now(),
  unique (patient_id, vital_type),
  check (urgent_below is null or attention_below is null or urgent_below <= attention_below),
  check (urgent_above is null or attention_above is null or urgent_above >= attention_above)
);

create index patient_vital_monitoring_plans_patient_idx
  on public.patient_vital_monitoring_plans(patient_id, vital_type);

alter table public.patient_vital_monitoring_plans enable row level security;

create policy "synthetic demo vital plans are readable" on public.patient_vital_monitoring_plans for select to anon, authenticated using (
  exists (select 1 from public.patients where patients.id = patient_vital_monitoring_plans.patient_id and patients.is_synthetic)
);
