# Automated Nursing Shift Handoff Board

Step 1 provides a synthetic-data-only Next.js foundation, typed chart-event contracts, a
deterministic upcoming-item/freshness engine, and Supabase schema plus seed files.

## Local use

Run `npm run dev` to view the fixture-backed foundation. It does not require Supabase or an
OpenAI key. Run `npm run typecheck`, `npm test`, and `npm run build` before changes.

## Optional Supabase setup

Create a Supabase project, copy `.env.example` to `.env.local`, and add the project URL plus
anon key. Apply `supabase/migrations/202609260001_foundation.sql`, then run
`supabase/seed.sql` against that project. The Step 1 screen deliberately remains fixture-backed;
it does not yet read or write Supabase. All tables have RLS enabled and no browser policies, so
an anonymous browser cannot access the synthetic records. A later server-side data adapter and
authenticated access design are required before the board can use persisted data.

## Model selection

`OPENAI_MODEL` defaults to `gpt-5-mini`, so development and tests do not default to Astra.
Set it to `gpt-6-astra` only for a deliberate high-capability evaluation in the later agent
pipeline stage.
