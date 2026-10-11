# Automated Nursing Shift Handoff Board

This is a synthetic-data-only Next.js learning project. The board uses fictional chart events and
shows a persistent non-clinical-use notice. Never enter real patient information or use this
project for care or clinical decisions.

## Local use

Install dependencies and run the app:

```bash
npm install
npm run dev
```

The default board uses synthetic fixtures and does not require Supabase or an API key. Validate
changes with:

```bash
npm run typecheck
npm test
```

## LangGraph.js handoff flow (Phase 1)

`src/lib/handoff/graph/index.ts` implements a LangGraph.js `StateGraph`; `pipeline.ts` re-exports
the workflow for existing app callers. Its fixture data layer and
fixture agents run offline, making them suitable for learning and tests without network access.
The graph loads only synthetic patient context, computes monitoring attention and due times with
the deterministic vital engine, retrieves fixed fixture protocol context, and fans out chart/vital,
medication, and task/incident specialists before joining their facts.

The SBAR synthesizer proposes claims; code then checks that each claim cites existing specialist
evidence and that numeric details occur in cited event payloads. A verifier gap can trigger one
synthesis retry. Supported claims are stored as an immutable candidate and the graph pauses for
human review. Only an explicit approval appends a separate publication event; rejection leaves the
candidate unpublished. Any agent, schema, or evidence failure is recorded as a failed version.
No model computes clinical thresholds, attention tiers, or due times.

```text
START -> load_context -> deterministic_engine -> retrieve_protocols
  -> [chart_vitals, medications, tasks_incidents] -> join_facts
  -> synthesize_sbar -> verify_evidence
       -> retry synthesis once when gaps remain
       -> failure_sink when no claims are supported
       -> assemble_candidate -> human_review
             -> publish only after approval
             -> END after rejection
```

`src/lib/handoff/data-layer.ts` defines the event, monitoring-plan, knowledge, version, and
publication ports. The workflow supports in-memory fixtures and server-only Supabase data sources.
The server-only OpenAI adapter is opt-in through
`createOpenAiHandoffPipeline()` and `OPENAI_API_KEY`; tests use fixture agents only.

See [docs/handoff-graph.md](./docs/handoff-graph.md) for the detailed graph state, node,
checkpointing, and testing guide.

## Protocol context (Phase 3)

The graph can retrieve up to three synthetic formatting/boundary chunks from Supabase using
Gemini `gemini-embedding-001` embeddings. Retrieved text is passed to synthesis and verification
only; deterministic attention, trend, plausibility, and due-time rules never use protocol text.
Claims that cite protocol context must name retrieved chunk IDs, and code rejects unknown chunk
IDs in addition to checking source-event evidence.

Apply `supabase/migrations/202610120001_protocol_knowledge_chunks.sql`, then set the server-only
`GOOGLE_API_KEY` and run `npm run ingest:protocols` to embed the Markdown files in
`data/protocols/`. Fixture mode and automated tests continue to use fixed in-memory chunks without
an API key or network access.

## Optional Supabase setup

Create a Supabase project, copy `.env.example` to `.env.local`, and add the project URL, anon key,
the **server-only** service-role key, a direct Postgres connection string as `SUPABASE_DB_URL`,
and a long random `DEMO_SESSION_SECRET`. Apply all migrations in order, then run
`supabase/seed.sql` against that project. The service key, database connection string, and session
secret must never reach the browser.

The shared workflow requires this Supabase setup. A selected fictional nurse receives a signed,
HTTP-only demo session; review notes, approvals, rejections, publications, and audit events are
written by server-only database functions. Candidate versions stay immutable. Publishing appends a
publication event, so the current published handoff is determined by the latest publication
rather than by the highest version number.

The LangGraph workflow stores checkpoint state in Postgres so a candidate can remain paused for
review across server restarts. The review API accepts only `approved` or `rejected`; approval
resumes the graph and appends the publication record. The older standalone publish endpoint no
longer publishes candidates.

Migration `202610110001_langgraph_review_threads.sql` adds the private candidate-to-checkpoint
mapping. The LangGraph Postgres saver initializes its checkpoint tables on first server use.

The vital-monitoring demo adds a patient-specific synthetic monitoring plan for BP, heart rate,
temperature, oxygen saturation, or blood glucose. When a fictional nurse records a new vital, the
server appends a source event, deterministically calculates the next due time and configured
synthetic attention tier, then creates an immutable, evidence-linked candidate handoff. A nurse
still reviews and publishes that candidate; the system never auto-publishes or makes a clinical
decision.

Supabase Realtime subscribes to inserted `patient_chart_events`, handoff candidates, reviews, and
publications so connected boards update immediately. Public Supabase read policies are restricted
to rows whose patient is marked `is_synthetic = true`; do not reuse them for real clinical data.

## Model selection

`OPENAI_MODEL` defaults to `gpt-5-mini`, so development and tests do not default to Astra. Set it
to `gpt-6-astra` only for a deliberate high-capability evaluation in the later agent pipeline
stage.

The OpenAI adapter sets response storage to false and must only receive synthetic records. It
records structured agent diagnostics and evidence IDs, not hidden model reasoning. The server-only
OpenAI pipeline is available for deliberate evaluation code paths; it is not reachable from the
public refresh endpoint.

## Deploying the synthetic demo

This Next.js project is ready to import into Vercel. It deliberately contains no deployment token,
Supabase key, or OpenAI key. Configure values through Vercel's managed environment-variable UI or
CLI—never in source control.

1. Import [the GitHub repository](https://github.com/samee2612/handoff-board) into Vercel and use
   the detected Next.js settings (`npm ci`, then `npm run build`).
2. Set `HANDOFF_BOARD_DATA_MODE=synthetic-only` in both Preview and Production. Hosted requests
   fail closed if this declaration is missing or has any other value.
3. For the default fixture-only deployment, leave the remaining values unset. To use the shared
   vital-recording workflow, apply all migrations and seed data, then set:

   | Variable | Exposure | Purpose |
   | --- | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Public | Synthetic Supabase project URL. |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Browser Realtime connection for synthetic source events. |
   | `SUPABASE_SERVICE_ROLE_KEY` | Secret | Server-only synthetic candidate persistence. Never prefix this with `NEXT_PUBLIC_`. |
   | `SUPABASE_DB_URL` | Secret | Server-only Postgres connection for durable LangGraph checkpoints. |
   | `DEMO_SESSION_SECRET` | Secret | Long random value used to sign controlled fictional-nurse sessions. |
   | `OPENAI_API_KEY` | Secret | Optional offline pipeline evaluation only; the public refresh route cannot call it. |
   | `GOOGLE_API_KEY` | Secret | Gemini protocol embeddings for live Supabase retrieval and ingestion only. |

4. Deploy from `main`. GitHub Actions verifies type checks, tests, and a production build before
   the commit is considered ready. Vercel's Git integration can then create Preview deployments
   for pull requests and Production deployments for `main`.

## Standalone Python LangGraph demo

The repository also contains an earlier terminal-only Python exercise using `handoff_graph.py`,
`run.py`, and `data/notes.json`. It is separate from the Next.js application above and remains
synthetic-data-only.

Create and activate a virtual environment, then install its dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

That script uses the configured Gemini model and reads `GEMINI_API_KEY` (or `GOOGLE_API_KEY`).
Set `USE_FAKE_LLM=1` to exercise the retry and approval flow without an API request:

```bash
export USE_FAKE_LLM=1
python run.py
```

Type notes as `HH:MM note text`, one per line, or submit a blank line to use `data/notes.json`.
The script checks citations, pauses for approval, and writes approved JSON to `output/`.
`test_handoff_graph.py` contains its pytest tests.

Neither demo is for real patient records, clinical care, or medical decision-making. Keep all data
fictional and retain the in-app non-clinical-use notice.
