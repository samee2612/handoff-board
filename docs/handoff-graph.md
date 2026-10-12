# LangGraph.js handoff workflow

This guide describes the fixture graph and protocol retrieval. It is a learning demo for fictional data only,
not a clinical tool. The app's non-clinical-use banner must remain visible.

## State and graph

The `Annotation.Root` state in `src/lib/handoff/graph/index.ts` carries patient and trigger IDs,
the event snapshot, the deterministic monitoring plan/result, specialist facts, proposed claims,
verification decisions, retry feedback, diagnostics, candidate version ID, review decision, status,
and failure details. `facts` and `diagnostics` use append reducers because their specialist nodes
run concurrently; ordinary fields use replacement reducers.

```text
START -> load_context -> deterministic_engine -> retrieve_protocols
  -> chart_vitals + medications + tasks_incidents (parallel)
  -> join_facts -> synthesize_sbar -> verify_evidence
      -> synthesize_sbar (one retry when gaps remain)
      -> assemble_candidate -> human_review
          -> publish (approved only)
          -> END (rejected)
      -> failure_sink (failed run)
```

`load_context` accepts only a synthetic patient and events belonging to that patient.
Fixture contracts also accept `demo-patient-N` patient IDs and the `nN`/`mNN` note IDs used by
`data/notes*.json`, preserving those IDs in citations. Supabase tables remain UUID-backed; these
file-based fixture IDs are for in-memory runs and are not database IDs.
`deterministic_engine` calls `evaluateHandoffRules`; no model chooses thresholds, attention, trends,
or due times. Protocol retrieval happens after this node, so retrieved text cannot affect
deterministic calculations. The engine checks synthetic plausibility ranges, emits trend facts for the last four
valid systolic-BP or heart-rate readings in the prior eight hours, and separately flags malformed BP
values, out-of-range values, attention levels, and overdue open tasks. Attention uses the most severe
valid reading for the configured vital type during the run; `nextDueAt` uses the latest valid reading.
Trend thresholds and the reading count/window can be configured in the helper; invalid readings are
excluded from both trends and plan attention. These flags are displayed separately and are never claims.

Each specialist receives only its event categories. Synthesis receives specialist and deterministic
trend facts plus protocol context. The verifier can see the retrieved chunks; any chunk citation
on a claim must match a chunk returned for that run. Before the model verifier runs, code checks
that event citations belong to specialist facts and source events, protocol citations belong to the
retrieved set, and claim numbers are present in cited source payloads or event times. A deterministic
gap overrides a model's supported decision. Protocol chunks are context only, never patient evidence
or clinical guidance.

Supported candidates are immutable and stored before review. LangGraph `interrupt()` pauses at
`human_review`; resuming with `approved` appends a separate publication record, while `rejected`
does not publish. Invalid decisions are refused. No graph path can publish without passing through
human review.

## Data sources and checkpointing

`src/lib/handoff/data-layer.ts` defines `EventSource`, `PlanSource`, `KnowledgeSource`,
`VersionStore`, and `PublicationStore`; `InMemoryHandoffDataLayer` returns fixed protocol chunks for
offline tests. `SupabaseHandoffDataLayer` embeds retrieval queries with Gemini and searches stored
chunks using the `match_knowledge_chunks` RPC; it reads and persists only synthetic records. It stores the
candidate-to-thread association separately so the immutable version output remains unchanged.
Tests use `MemorySaver`; server runs use `PostgresSaver` with `SUPABASE_DB_URL`. Both set
`thread_id` to `runId`. The scripted fake LLM logs each node/input call and consumes queued
responses before using its fixture fallback.

Migration `202610110001_langgraph_review_threads.sql` adds a private mapping table for candidate
IDs and paused graph thread IDs; it does not change the immutable `HandoffVersion` shape.
`PostgresSaver.setup()` initializes its own checkpoint tables on first use.

Migration `202610120001_protocol_knowledge_chunks.sql` adds the private `knowledge_chunks` table
and cosine-distance search function with 768-dimensional vectors. The ingestion command reads only
`data/protocols/*.md`, uses `RETRIEVAL_DOCUMENT` vectors, and upserts by source path and chunk index.
Live retrieval uses `RETRIEVAL_QUERY`; both use `gemini-embedding-001` and the server-only
`GOOGLE_API_KEY`. Apply the migration before ingesting. Set `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `GOOGLE_API_KEY`, then run:

```bash
npm run ingest:protocols
```

The review API records the nurse's decision and resumes that checkpoint. Only `approved` and
`rejected` are accepted; on approval, the graph appends a publication through the existing
database publication function, which independently requires a recorded approval. The standalone
publish endpoint returns `405` so publication cannot bypass graph review.

Run the graph tests without API keys or network access:

```bash
npm run test:graph
npm run typecheck
npm test
```

For Supabase integration checks, set `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_DB_URL` in `.env.local`
and apply migrations in order before seeding the fictional records. Gemini is not needed for fixture
tests; live protocol retrieval also requires `GOOGLE_API_KEY`.

The graph test suite is under `src/lib/handoff/graph/__tests__/`. Each test creates a fresh graph,
checkpointer, data source, and scripted LLM.
