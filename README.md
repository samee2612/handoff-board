# Automated Nursing Shift Handoff Board

Step 1 provides a synthetic-data-only Next.js foundation, typed chart-event contracts, a
deterministic upcoming-item/freshness engine, and Supabase schema plus seed files.

Step 2 adds a typed, fail-closed multi-agent handoff pipeline. The default local pipeline uses
deterministic fixture specialists; `createOpenAiHandoffPipeline()` explicitly creates the
server-only OpenAI Structured Outputs variant from `OPENAI_API_KEY`. Medication timing, PRN eligibility, task timing, and freshness are
always computed by the deterministic engine—not by the model.

Step 5 makes the repository ready for a hosted synthetic-only demo: deployment verification runs
on every pull request and `main` push, hosted environments fail closed without an explicit
synthetic-only declaration, and every page carries a persistent non-clinical-use notice.

## Local use

Run `npm run dev` to view the fixture-backed foundation. It does not require Supabase or an
OpenAI key. Run `npm run typecheck`, `npm test`, and `npm run build` before changes.

## Optional Supabase setup

Create a Supabase project, copy `.env.example` to `.env.local`, and add the project URL, anon
key, and the **server-only** service-role key. Apply both migrations in order, then run
`supabase/seed.sql` against that project. Step 4 uses the service key only on the Next.js server
to load and persist synthetic candidates. It never reaches the browser.

Step 4 enables a browser Realtime subscription only for inserted rows in
`patient_chart_events`. A new event updates deterministic tile alerts/freshness and marks the
existing handoff stale; it never invokes an LLM or publishes a handoff automatically. The nurse
must select **Refresh handoff** to create an immutable `candidate` version. Candidate versions are
not auto-published. The demo's public Supabase read policies are deliberately restricted to rows
whose patient is marked `is_synthetic = true`; do not reuse them for real clinical data.

## Model selection

`OPENAI_MODEL` defaults to `gpt-5-mini`, so development and tests do not default to Astra.
Set it to `gpt-6-astra` only for a deliberate high-capability evaluation in the later agent
pipeline stage.

The OpenAI adapter sets response storage to false and must only receive synthetic records in
this demo. It records structured agent diagnostics and evidence IDs, not hidden model reasoning.

Explicit board refreshes remain deterministic and cost-free in this unauthenticated synthetic demo.
The server-only OpenAI pipeline is available for deliberate evaluation code paths, but is not
reachable from the public refresh endpoint until an authenticated authorization design exists.

## Deploying the synthetic demo

This Next.js project is ready to import into Vercel. It deliberately contains no deployment token,
Supabase key, or OpenAI key. Configure values through Vercel's managed environment-variable UI or
CLI—never in source control.

1. Import [the GitHub repository](https://github.com/samee2612/handoff-board) into Vercel and use
   the detected Next.js settings (`npm ci`, then `npm run build`).
2. Set `HANDOFF_BOARD_DATA_MODE=synthetic-only` in both Preview and Production. Hosted requests
   fail closed if this declaration is missing or has any other value.
3. For the default fixture-only deployment, leave the remaining values unset. For optional live
   synthetic Supabase updates, first apply the migrations and seed data, then set:

   | Variable | Exposure | Purpose |
   | --- | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Public | Synthetic Supabase project URL. |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Browser Realtime connection for synthetic source events. |
   | `SUPABASE_SERVICE_ROLE_KEY` | Secret | Server-only synthetic candidate persistence. Never prefix this with `NEXT_PUBLIC_`. |
   | `OPENAI_API_KEY` | Secret | Optional offline pipeline evaluation only; the public refresh route cannot call it. |

4. Deploy from `main`. GitHub Actions verifies type checks, tests, and a production build before
   the commit is considered ready. Vercel's Git integration can then create Preview deployments
   for pull requests and Production deployments for `main`.

The deployed app is a training/demo artifact only: it must not be used for clinical care, clinical
decision-making, or real patient information. The persistent in-app banner is intentional and
must not be removed without a new safety review.
