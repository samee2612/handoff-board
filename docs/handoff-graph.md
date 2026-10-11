# LangGraph.js handoff workflow

This guide describes the Phase 1 fixture graph. It is a learning demo for fictional data only,
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
`deterministic_engine` calls `evaluateHandoffRules`; no model chooses thresholds, attention, trends,
or due times. The engine checks synthetic plausibility ranges, emits trend facts for the last four
valid systolic-BP or heart-rate readings in the prior eight hours, and separately flags unparsed
vital notes, out-of-range values, attention levels, and overdue open tasks. Trend thresholds and
the reading count/window can be configured in the helper; invalid readings are excluded from both
trends and plan attention. These flags are displayed separately and are never claims.

Each specialist receives only its event categories. Synthesis receives specialist and deterministic
trend facts, attention, due time, and protocol context. Before the model verifier runs, code checks
that event citations belong to specialist facts and source events, and that claim numbers are
present in cited source payloads or event times. A deterministic gap overrides a model's supported
decision. The deterministic rules are illustrative synthetic-data checks, not clinical guidance.

Supported candidates are immutable and stored before review. LangGraph `interrupt()` pauses at
`human_review`; resuming with `approved` appends a separate publication record, while `rejected`
does not publish. Invalid decisions are refused. No graph path can publish without passing through
human review.

## Fixture dependencies and tests

`src/lib/handoff/data-layer.ts` defines `EventSource`, `PlanSource`, `KnowledgeSource`,
`VersionStore`, and `PublicationStore`; `InMemoryHandoffDataLayer` implements those ports for
offline tests. Tests use `MemorySaver` and set `thread_id` to `runId`. The scripted fake LLM logs
each node/input call and consumes queued responses before using its fixture fallback.

Run the graph tests without API keys or network access:

```bash
npm run test:graph
npm run typecheck
npm test
```

The graph test suite is under `src/lib/handoff/graph/__tests__/`. Each test creates a fresh graph,
checkpointer, data source, and scripted LLM.
