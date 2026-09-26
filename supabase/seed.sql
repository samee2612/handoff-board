insert into public.units (id, name) values
  ('11111111-1111-4111-8111-111111111111', 'Fictional 4 West')
on conflict (id) do nothing;

insert into public.nurses (id, unit_id, display_name) values
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Jamie Rivera (fictional)')
on conflict (id) do nothing;

insert into public.patients (id, unit_id, assigned_nurse_id, display_name, room, admitted_at) values
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'Ava Miller (fictional)', '401-A', now() - interval '38 hours'),
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'Ben Carter (fictional)', '401-B', now() - interval '19 hours'),
  ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'Clara Reed (fictional)', '402-A', now() - interval '12 hours')
on conflict (id) do nothing;

insert into public.patient_chart_events (id, patient_id, category, occurred_at, recorded_at, source_label, payload) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '33333333-3333-4333-8333-333333333333', 'nursing_note', now() - interval '30 minutes', now() - interval '28 minutes', 'Fictional nursing progress note', '{"summary":"Resting in bed; reports surgical-site pain at 6/10."}'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '33333333-3333-4333-8333-333333333333', 'vital', now() - interval '45 minutes', now() - interval '44 minutes', 'Fictional vital-sign record', '{"heartRate":88,"systolicBloodPressure":128,"diastolicBloodPressure":76,"oxygenSaturation":97}'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '33333333-3333-4333-8333-333333333333', 'medication', now() - interval '120 minutes', now() - interval '119 minutes', 'Fictional MAR', jsonb_build_object('medicationName', 'Acetaminophen', 'dose', '650 mg', 'route', 'oral', 'scheduleType', 'scheduled', 'dueAt', now() + interval '40 minutes', 'status', 'active')),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', '33333333-3333-4333-8333-333333333333', 'task', now() - interval '60 minutes', now() - interval '60 minutes', 'Fictional care task list', jsonb_build_object('title', 'Reinforce ambulation plan', 'dueAt', now() + interval '20 minutes', 'status', 'open')),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '44444444-4444-4444-8444-444444444444', 'nursing_note', now() - interval '9 hours', now() - interval '8 hours 56 minutes', 'Fictional nursing progress note', '{"summary":"Reports intermittent pain; no new concerns documented."}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '44444444-4444-4444-8444-444444444444', 'vital', now() - interval '5 hours', now() - interval '4 hours 58 minutes', 'Fictional vital-sign record', '{"heartRate":92,"systolicBloodPressure":118,"diastolicBloodPressure":72,"oxygenSaturation":96}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', '44444444-4444-4444-8444-444444444444', 'medication', now() - interval '4 hours', now() - interval '4 hours', 'Fictional MAR', jsonb_build_object('medicationName', 'Oxycodone', 'dose', '5 mg', 'route', 'oral', 'scheduleType', 'prn', 'nextEligibleAt', now() + interval '15 minutes', 'status', 'active')),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', '44444444-4444-4444-8444-444444444444', 'task', now() - interval '40 minutes', now() - interval '40 minutes', 'Fictional care task list', '{"title":"Document intake and output","status":"open"}'),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '55555555-5555-4555-8555-555555555555', 'vital', now() - interval '7 minutes', now() - interval '6 minutes', 'Fictional vital-sign record', '{"heartRate":84,"systolicBloodPressure":116,"diastolicBloodPressure":70,"oxygenSaturation":98}'),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', '55555555-5555-4555-8555-555555555555', 'incident', now() - interval '90 minutes', now() - interval '85 minutes', 'Fictional incident record', '{"description":"Near-fall reported during transfer; provider notified in scenario.","resolved":false}')
on conflict (id) do nothing;
