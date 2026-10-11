import { randomUUID } from "node:crypto";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import type {
  AgentDiagnostic,
  ChartEvent,
  ExtractedFact,
  HandoffClaim,
  HandoffFailure,
  HandoffVersion,
  Patient,
  SpecialistName,
  VerificationDecision,
  VitalMonitoringPlan,
} from "@/lib/contracts";
import {
  chartEventSchema,
  extractedFactSchema,
  handoffClaimSchema,
  handoffVersionSchema,
  patientSchema,
  verificationDecisionSchema,
  vitalMonitoringPlanSchema,
} from "@/lib/contracts";
import {
  ChartVitalsSpecialist,
  EvidenceVerifier,
  MedicationSpecialist,
  SbarSynthesizer,
  TasksIncidentsSpecialist,
  type HandoffSynthesisContext,
  type SpecialistAgent,
} from "@/lib/handoff/agents";
import {
  InMemoryHandoffDataLayer,
  type HandoffDataLayer,
} from "@/lib/handoff/data-layer";
import { HandoffPipelineError, toPipelineError } from "@/lib/handoff/errors";
import { evaluateHandoffRules } from "@/lib/engine/handoff-rules";
import type { HandoffFlag } from "@/lib/engine/handoff-rules";
import type { VitalAttention } from "@/lib/vitals/monitoring";
import type { StructuredOutputClient } from "@/lib/handoff/structured-output";

export type HandoffGraphStatus =
  | "running"
  | "awaiting_review"
  | "approved"
  | "published"
  | "rejected"
  | "failed";

const HandoffState = Annotation.Root({
  patientId: Annotation<string>(),
  triggerEventId: Annotation<string>(),
  runId: Annotation<string>(),
  generatedAt: Annotation<string>(),
  events: replaceValue<ChartEvent[]>(() => []),
  plan: replaceValue<Awaited<ReturnType<HandoffDataLayer["getPlan"]>>>(() => null),
  attention: replaceValue<VitalAttention | null>(() => null),
  nextDueAt: replaceValue<string | null>(() => null),
  protocolChunks: replaceValue<HandoffSynthesisContext["protocolChunks"]>(() => []),
  // Parallel specialist nodes can safely append facts in the same graph step.
  facts: Annotation<ExtractedFact[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  // Engine quality and attention flags are separate from LLM-drafted claims.
  flags: Annotation<HandoffFlag[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  claims: replaceValue<HandoffClaim[]>(() => []),
  decisions: replaceValue<VerificationDecision[]>(() => []),
  retryCount: replaceValue<number>(() => 0),
  maxRetries: replaceValue<number>(() => 1),
  gapFeedback: replaceValue<string[]>(() => []),
  supportedClaims: replaceValue<HandoffClaim[]>(() => []),
  excludedClaims: replaceValue<HandoffVersion["excludedClaims"]>(() => []),
  // Diagnostics also come from parallel specialist nodes, so they use an append reducer.
  diagnostics: Annotation<AgentDiagnostic[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  versionId: replaceValue<string | null>(() => null),
  reviewDecision: replaceValue<"approved" | "rejected" | null>(() => null),
  status: replaceValue<HandoffGraphStatus>(() => "running"),
  failure: replaceValue<HandoffFailure | null>(() => null),
});

function replaceValue<Value>(defaultValue: () => Value) {
  return Annotation<Value>({
    reducer: (_current, update) => update,
    default: defaultValue,
  });
}

export type HandoffGraphState = typeof HandoffState.State;

export type HandoffAgents = {
  specialists: Partial<Record<SpecialistName, SpecialistAgent>>;
  synthesizer: SbarSynthesizer;
  verifier: EvidenceVerifier;
};

export type HandoffGraphDependencies = {
  data: HandoffDataLayer;
  agents: HandoffAgents;
};

export type VerifyRouteState = Pick<
  HandoffGraphState,
  "status" | "excludedClaims" | "retryCount" | "maxRetries" | "supportedClaims" | "gapFeedback"
>;

export function routeAfterVerify(state: VerifyRouteState):
  | "failure_sink"
  | "synthesize_sbar"
  | "assemble_candidate" {
  if (state.status === "failed") return "failure_sink";
  if (
    (state.excludedClaims.length > 0 || state.gapFeedback.length > 0) &&
    state.retryCount < state.maxRetries
  ) return "synthesize_sbar";
  if (state.excludedClaims.length > 0 || state.gapFeedback.length > 0) return "failure_sink";
  if (state.supportedClaims.length > 0) return "assemble_candidate";
  return "failure_sink";
}

type AgentName = SpecialistName | "sbar_synthesizer" | "evidence_verifier";
type AgentResult<T> = { value: T; diagnostic: AgentDiagnostic } | { diagnostic: AgentDiagnostic; error: HandoffPipelineError };

const specialistCategories: Record<SpecialistName, ChartEvent["category"][]> = {
  chart_vitals: ["nursing_note", "vital"],
  medications: ["medication"],
  tasks_incidents: ["task", "incident"],
};

function modelFor(name: AgentName, dependencies: HandoffGraphDependencies): string {
  if (name === "sbar_synthesizer") return dependencies.agents.synthesizer.model;
  if (name === "evidence_verifier") return dependencies.agents.verifier.model;
  return dependencies.agents.specialists[name]?.model ?? "deterministic-fixture";
}

async function runAgent<T>(input: {
  state: HandoffGraphState;
  agent: AgentName;
  model: string;
  inputEventCount: number;
  operation: () => Promise<T>;
  outputCount: (value: T) => number;
}): Promise<AgentResult<T>> {
  const startedAt = new Date().toISOString();
  try {
    const value = await input.operation();
    return {
      value,
      diagnostic: {
        runId: input.state.runId,
        agent: input.agent,
        status: "succeeded",
        model: input.model,
        startedAt,
        completedAt: new Date().toISOString(),
        inputEventCount: input.inputEventCount,
        outputCount: input.outputCount(value),
      },
    };
  } catch (error) {
    const failure = error instanceof SyntaxError
      ? new HandoffPipelineError("INVALID_LLM_JSON", error.message)
      : toPipelineError(error, "AGENT_FAILURE");
    return {
      error: failure,
      diagnostic: {
        runId: input.state.runId,
        agent: input.agent,
        status: "failed",
        model: input.model,
        startedAt,
        completedAt: new Date().toISOString(),
        inputEventCount: input.inputEventCount,
        outputCount: 0,
        errorCode: failure.code,
        errorMessage: failure.message,
      },
    };
  }
}

function failedState(error: unknown, fallbackCode: string): Pick<HandoffGraphState, "failure" | "status"> {
  const failure = toPipelineError(error, fallbackCode);
  return { status: "failed", failure: { code: failure.code, message: failure.message } };
}

function failedAgentState(diagnostic: AgentDiagnostic): Pick<HandoffGraphState, "diagnostics"> {
  return { diagnostics: [diagnostic] };
}

function sourceEventCutoff(events: ChartEvent[], fallback: string): string {
  return events.reduce((latest, event) => event.recordedAt > latest ? event.recordedAt : latest, fallback);
}

function numericTokens(value: string): string[] {
  return value.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
}

function codeCheckClaims(
  claims: HandoffClaim[],
  facts: ExtractedFact[],
  events: ChartEvent[],
  protocolChunks: HandoffSynthesisContext["protocolChunks"],
): VerificationDecision[] {
  const factEventIds = new Set(facts.flatMap((fact) => fact.evidenceEventIds));
  const eventById = new Map(events.map((event) => [event.id, event]));
  const protocolChunkIds = new Set(protocolChunks.map((chunk) => chunk.id));

  return claims.map((rawClaim) => {
    const claim = handoffClaimSchema.parse(rawClaim);
    if (claim.evidenceEventIds.length === 0 || claim.evidenceEventIds.some((id) => !factEventIds.has(id) || !eventById.has(id))) {
      return {
        claimId: claim.id,
        status: "gap",
        reason: `Claim '${claim.id}' cites an event absent from specialist facts.`,
      };
    }

    const missingProtocolChunk = (claim.evidenceProtocolChunkIds ?? [])
      .find((id) => !protocolChunkIds.has(id));
    if (missingProtocolChunk) {
      return {
        claimId: claim.id,
        status: "gap",
        reason: `Claim '${claim.id}' cites protocol chunk '${missingProtocolChunk}' absent from retrieved context.`,
      };
    }

    const citedPayload = claim.evidenceEventIds
      .map((id) => {
        const event = eventById.get(id)!;
        const occurrenceTime = new Date(event.occurredAt).toISOString().slice(11, 16);
        return `${JSON.stringify(event.payload)} ${occurrenceTime}`;
      })
      .join(" ");
    const payloadNumbers = new Set(numericTokens(citedPayload));
    const unsupportedNumber = numericTokens(claim.text).find((number) => !payloadNumbers.has(number));
    return unsupportedNumber
      ? {
          claimId: claim.id,
          status: "gap",
          reason: `Claim '${claim.id}' contains number '${unsupportedNumber}' absent from its cited event payloads or occurrence time.`,
        }
      : {
          claimId: claim.id,
          status: "supported",
          reason: "Cited event IDs and numeric details passed deterministic checks.",
        };
  });
}

function validateAgentFacts(
  name: SpecialistName,
  facts: ExtractedFact[],
  scopedEvents: ChartEvent[],
): ExtractedFact[] {
  const allowedEventIds = new Set(scopedEvents.map((event) => event.id));
  return facts.map((rawFact) => {
    const fact = extractedFactSchema.parse(rawFact);
    if (fact.specialist !== name || fact.evidenceEventIds.length === 0 || fact.evidenceEventIds.some((id) => !allowedEventIds.has(id))) {
      throw new HandoffPipelineError("INVALID_SPECIALIST_EVIDENCE", `${name} returned invalid or out-of-scope event evidence.`);
    }
    return fact;
  });
}

function withStateDefaults(input: {
  patientId: string;
  triggerEventId: string;
  runId?: string;
  generatedAt?: Date;
  maxRetries?: number;
}): HandoffGraphState {
  return {
    patientId: input.patientId,
    triggerEventId: input.triggerEventId,
    runId: input.runId ?? randomUUID(),
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    events: [],
    plan: null,
    attention: null,
    nextDueAt: null,
    protocolChunks: [],
    facts: [],
    flags: [],
    claims: [],
    decisions: [],
    retryCount: 0,
    maxRetries: input.maxRetries ?? 1,
    gapFeedback: [],
    supportedClaims: [],
    excludedClaims: [],
    diagnostics: [],
    versionId: null,
    reviewDecision: null,
    status: "running",
    failure: null,
  };
}

function makeSpecialistNode(name: SpecialistName, dependencies: HandoffGraphDependencies) {
  return async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    const categories = specialistCategories[name];
    const scopedEvents = state.events.filter((event) => categories.includes(event.category));
    const specialist = dependencies.agents.specialists[name];
    const result = await runAgent({
      state,
      agent: name,
      model: specialist?.model ?? "deterministic-fixture",
      inputEventCount: scopedEvents.length,
      operation: async () => {
        if (!specialist) throw new HandoffPipelineError("SPECIALIST_MISSING", `No ${name} specialist is configured.`);
        const extracted = await specialist.extract(scopedEvents);
        if (extracted.specialist !== name) {
          throw new HandoffPipelineError("INVALID_SPECIALIST_OUTPUT", `${name} returned a mismatched specialist name.`);
        }
        return validateAgentFacts(name, extracted.facts, scopedEvents);
      },
      outputCount: (facts) => facts.length,
    });
    return "error" in result
      ? failedAgentState(result.diagnostic)
      : { facts: result.value, diagnostics: [result.diagnostic] };
  };
}

/** Build the fixture-capable graph. The caller controls its data ports and checkpointer. */
export function buildHandoffGraph(
  dependencies: HandoffGraphDependencies,
  checkpointer: BaseCheckpointSaver = new MemorySaver(),
) {
  const loadContext = async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    try {
      const patient = await dependencies.data.getPatient(state.patientId);
      if (!patient) throw new HandoffPipelineError("PATIENT_NOT_FOUND", "The requested synthetic patient was not found.");
      if (patient.isSynthetic !== true) {
        return {
          status: "rejected",
          failure: {
            code: "NON_SYNTHETIC_PATIENT",
            message: "Handoffs can only be generated for synthetic patients.",
          },
        };
      }
      const parsedPatient = patientSchema.safeParse(patient);
      if (!parsedPatient.success) throw new HandoffPipelineError("INVALID_PATIENT", "The patient record failed schema validation.");
      const rawEvents = await dependencies.data.getEvents(state.patientId);
      const parsedEvents = chartEventSchema.array().safeParse(rawEvents);
      if (!parsedEvents.success) throw new HandoffPipelineError("INVALID_CHART_EVENTS", "Chart events failed schema validation.");
      if (parsedEvents.data.some((event) => event.patientId !== state.patientId)) {
        throw new HandoffPipelineError("MIXED_PATIENT_EVENTS", "A graph run may only load events for its patient.");
      }
      if (!parsedEvents.data.some((event) => event.id === state.triggerEventId)) {
        throw new HandoffPipelineError("TRIGGER_EVENT_NOT_FOUND", "The trigger event is not part of this patient's chart.");
      }
      return { events: parsedEvents.data };
    } catch (error) {
      return failedState(error, "CONTEXT_LOAD_FAILED");
    }
  };

  const deterministicEngine = async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    try {
      const rawPlan = await dependencies.data.getPlan(state.patientId, state.triggerEventId);
      let plan: VitalMonitoringPlan | null = null;
      if (rawPlan) {
        const parsedPlan = vitalMonitoringPlanSchema.safeParse(rawPlan);
        if (!parsedPlan.success) {
          throw new HandoffPipelineError("INVALID_MONITORING_PLAN", "The monitoring plan failed schema validation.");
        }
        plan = parsedPlan.data;
      }
      const result = evaluateHandoffRules(state.events, plan, new Date(state.generatedAt));
      return {
        plan,
        attention: result.attention,
        nextDueAt: result.nextDueAt,
        facts: result.trendFacts,
        flags: result.flags,
      };
    } catch (error) {
      return failedState(error, "DETERMINISTIC_ENGINE_FAILED");
    }
  };

  const retrieveProtocols = async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    try {
      const trigger = state.events.find((event) => event.id === state.triggerEventId);
      const query = trigger ? `${trigger.category}: ${JSON.stringify(trigger.payload)}` : "handoff format";
      const chunks = await dependencies.data.retrieve(query, 3);
      if (chunks.length > 3 || chunks.some((chunk) => !chunk.id || !chunk.text)) {
        throw new HandoffPipelineError("INVALID_PROTOCOL_CONTEXT", "Protocol retrieval returned invalid context.");
      }
      return { protocolChunks: chunks };
    } catch (error) {
      return failedState(error, "PROTOCOL_RETRIEVAL_FAILED");
    }
  };

  const joinFacts = (state: HandoffGraphState): Partial<HandoffGraphState> => {
    if (state.status === "failed") return {};
    const failedSpecialist = state.diagnostics.find((item) =>
      specialistCategories[item.agent as SpecialistName] !== undefined && item.status === "failed",
    );
    if (!failedSpecialist) return {};
    return {
      ...failedState(
        new HandoffPipelineError(
          failedSpecialist.errorCode ?? "SPECIALIST_FAILURE",
          failedSpecialist.errorMessage ?? "A specialist failed.",
        ),
        "SPECIALIST_FAILURE",
      ),
    };
  };

  const synthesizeSbar = async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    const retryCount = state.gapFeedback.length > 0 || state.excludedClaims.length > 0
      ? state.retryCount + 1
      : state.retryCount;
    const context: HandoffSynthesisContext = {
      attention: state.attention,
      nextDueAt: state.nextDueAt,
      protocolChunks: state.protocolChunks,
      gapFeedback: state.gapFeedback,
    };
    const result = await runAgent({
      state,
      agent: "sbar_synthesizer",
      model: dependencies.agents.synthesizer.model,
      inputEventCount: new Set(state.facts.flatMap((fact) => fact.evidenceEventIds)).size,
      operation: async () => {
        const rawClaims = await dependencies.agents.synthesizer.synthesize(state.facts, state.events, context);
        return rawClaims.map((claim) => handoffClaimSchema.parse(claim));
      },
      outputCount: (claims) => claims.length,
    });
    return "error" in result && result.error.code === "INVALID_LLM_JSON"
      ? {
          claims: [],
          gapFeedback: [`Draft response was not valid JSON: ${result.error.message}`],
          retryCount,
          diagnostics: [result.diagnostic],
        }
      : "error" in result
      ? { ...failedState(result.error, "SYNTHESIS_FAILURE"), diagnostics: [result.diagnostic] }
      : { claims: result.value, retryCount, diagnostics: [result.diagnostic] };
  };

  const verifyEvidence = async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    try {
      if (state.claims.length === 0 && state.gapFeedback.length > 0) {
        return { decisions: [], supportedClaims: [], excludedClaims: [] };
      }
      // Deterministic evidence checks run before an LLM verifier is allowed to weigh in.
      const codeDecisions = codeCheckClaims(state.claims, state.facts, state.events, state.protocolChunks);
      const result = await runAgent({
        state,
        agent: "evidence_verifier",
        model: dependencies.agents.verifier.model,
        inputEventCount: state.events.length,
        operation: async () => {
          const raw = await dependencies.agents.verifier.verify(
            state.claims,
            state.facts,
            state.events,
            state.protocolChunks,
          );
          const decisions = raw.map((decision) => verificationDecisionSchema.parse(decision));
          const ids = new Set(decisions.map((decision) => decision.claimId));
          if (ids.size !== state.claims.length || state.claims.some((claim) => !ids.has(claim.id))) {
            throw new HandoffPipelineError("INCOMPLETE_VERIFICATION", "The verifier must return one decision for every claim.");
          }
          return decisions;
        },
        outputCount: (decisions) => decisions.length,
      });
      if ("error" in result) return { ...failedState(result.error, "VERIFICATION_FAILURE"), diagnostics: [result.diagnostic] };

      const llmDecisionByClaim = new Map(result.value.map((decision) => [decision.claimId, decision]));
      const codeDecisionByClaim = new Map(codeDecisions.map((decision) => [decision.claimId, decision]));
      const effectiveDecisions = state.claims.map((claim) => {
        const codeDecision = codeDecisionByClaim.get(claim.id);
        return codeDecision?.status === "gap"
          ? codeDecision
          : llmDecisionByClaim.get(claim.id)!;
      });
      const decisionByClaim = new Map(effectiveDecisions.map((decision) => [decision.claimId, decision]));
      const roundSupported = state.claims.filter((claim) => decisionByClaim.get(claim.id)?.status === "supported");
      const roundExcluded = state.claims.flatMap((claim) => {
        const decision = decisionByClaim.get(claim.id);
        return decision?.status === "gap" ? [{ claim, reason: decision.reason }] : [];
      });
      const supportedById = new Map([...state.supportedClaims, ...roundSupported].map((claim) => [claim.id, claim]));
      const excludedById = new Map([...state.excludedClaims, ...roundExcluded].map((item) => [item.claim.id, item]));
      for (const id of supportedById.keys()) excludedById.delete(id);
      return {
        decisions: effectiveDecisions,
        supportedClaims: [...supportedById.values()],
        excludedClaims: [...excludedById.values()],
        gapFeedback: roundExcluded.map(({ claim, reason }) => `${claim.id}: ${reason}`),
        diagnostics: [result.diagnostic],
      };
    } catch (error) {
      return failedState(error, "EVIDENCE_CHECK_FAILED");
    }
  };

  const assembleCandidate = async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    try {
      const draft = {
        patientId: state.patientId,
        sourceEventCutoff: sourceEventCutoff(state.events, state.generatedAt),
        generatedAt: state.generatedAt,
        model: dependencies.agents.synthesizer.model,
        status: "candidate" as const,
        claims: state.supportedClaims,
        excludedClaims: state.excludedClaims,
        diagnostics: state.diagnostics,
        failure: null,
      };
      const version = await dependencies.data.append(draft);
      handoffVersionSchema.parse(version);
      return { versionId: version.id, status: "awaiting_review" };
    } catch (error) {
      return failedState(error, "CANDIDATE_PERSISTENCE_FAILED");
    }
  };

  const humanReview = (state: HandoffGraphState): Partial<HandoffGraphState> => {
    // interrupt pauses here; Command({ resume }) supplies the value returned from interrupt().
    const decision: unknown = interrupt({
      versionId: state.versionId,
      status: state.status,
      flags: state.flags,
    });
    if (decision !== "approved" && decision !== "rejected") {
      throw new HandoffPipelineError("INVALID_REVIEW_DECISION", "Review decision must be approved or rejected.");
    }
    return {
      reviewDecision: decision,
      status: decision === "approved" ? "approved" : "rejected",
    };
  };

  const publish = async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    try {
      if (state.reviewDecision !== "approved" || !state.versionId) {
        throw new HandoffPipelineError("APPROVAL_REQUIRED", "A stored version and explicit approval are required to publish.");
      }
      await dependencies.data.appendPublication({
        patientId: state.patientId,
        handoffVersionId: state.versionId,
        publishedByNurseId: null,
        note: null,
        publishedAt: new Date().toISOString(),
      });
      return { status: "published" };
    } catch (error) {
      return failedState(error, "PUBLICATION_FAILED");
    }
  };

  const failureSink = async (state: HandoffGraphState): Promise<Partial<HandoffGraphState>> => {
    const failure = state.failure ?? {
      code: "NO_SUPPORTED_CLAIMS",
      message: "No evidence-supported claims remain after the allowed retry.",
    };
    const version = await dependencies.data.append({
      patientId: state.patientId,
      sourceEventCutoff: sourceEventCutoff(state.events, state.generatedAt),
      generatedAt: state.generatedAt,
      model: dependencies.agents.synthesizer.model,
      status: "failed",
      claims: [],
      excludedClaims: state.excludedClaims,
      diagnostics: state.diagnostics,
      failure,
    });
    handoffVersionSchema.parse(version);
    return { versionId: version.id, status: "failed", failure };
  };

  const routeOnStatus = <Next extends string>(state: HandoffGraphState, next: Next): Next | "failure_sink" =>
    state.status === "failed" ? "failure_sink" : next;

  // Edges fan out the three specialists in parallel, then wait at a join barrier.
  return new StateGraph(HandoffState)
    .addNode("load_context", loadContext)
    .addNode("deterministic_engine", deterministicEngine)
    .addNode("retrieve_protocols", retrieveProtocols)
    .addNode("chart_vitals", makeSpecialistNode("chart_vitals", dependencies))
    .addNode("medications", makeSpecialistNode("medications", dependencies))
    .addNode("tasks_incidents", makeSpecialistNode("tasks_incidents", dependencies))
    .addNode("join_facts", joinFacts)
    .addNode("synthesize_sbar", synthesizeSbar)
    .addNode("verify_evidence", verifyEvidence)
    .addNode("assemble_candidate", assembleCandidate)
    .addNode("human_review", humanReview)
    .addNode("publish", publish)
    .addNode("failure_sink", failureSink)
    .addEdge(START, "load_context")
    .addConditionalEdges(
      "load_context",
      (state) => state.status === "rejected" ? END : routeOnStatus(state, "deterministic_engine"),
      {
        [END]: END,
        deterministic_engine: "deterministic_engine",
        failure_sink: "failure_sink",
      },
    )
    .addConditionalEdges("deterministic_engine", (state) => routeOnStatus(state, "retrieve_protocols"), {
      retrieve_protocols: "retrieve_protocols",
      failure_sink: "failure_sink",
    })
    .addEdge("retrieve_protocols", "chart_vitals")
    .addEdge("retrieve_protocols", "medications")
    .addEdge("retrieve_protocols", "tasks_incidents")
    .addEdge(["chart_vitals", "medications", "tasks_incidents"], "join_facts")
    .addConditionalEdges("join_facts", (state) => routeOnStatus(state, "synthesize_sbar"), {
      synthesize_sbar: "synthesize_sbar",
      failure_sink: "failure_sink",
    })
    .addConditionalEdges("synthesize_sbar", (state) => routeOnStatus(state, "verify_evidence"), {
      verify_evidence: "verify_evidence",
      failure_sink: "failure_sink",
    })
    .addConditionalEdges("verify_evidence", routeAfterVerify, {
      failure_sink: "failure_sink",
      synthesize_sbar: "synthesize_sbar",
      assemble_candidate: "assemble_candidate",
    })
    .addConditionalEdges("assemble_candidate", (state) => routeOnStatus(state, "human_review"), {
      human_review: "human_review",
      failure_sink: "failure_sink",
    })
    .addConditionalEdges("human_review", (state) => state.reviewDecision === "approved" ? "publish" : END, {
      publish: "publish",
      [END]: END,
    })
    .addConditionalEdges("publish", (state) => state.status === "failed" ? "failure_sink" : END, {
      failure_sink: "failure_sink",
      [END]: END,
    })
    .addEdge("failure_sink", END)
    .compile({ checkpointer });
}

function createFixtureAgents(client?: StructuredOutputClient): HandoffAgents {
  return {
    specialists: {
      chart_vitals: new ChartVitalsSpecialist(client),
      medications: new MedicationSpecialist(client),
      tasks_incidents: new TasksIncidentsSpecialist(client),
    },
    synthesizer: new SbarSynthesizer(client),
    verifier: new EvidenceVerifier(client),
  };
}

export class HandoffPipeline {
  private readonly data: HandoffDataLayer;
  private readonly graph: ReturnType<typeof buildHandoffGraph>;
  private readonly runByVersionId = new Map<string, string>();

  constructor(options?: {
    data?: HandoffDataLayer;
    agents?: HandoffAgents;
    client?: StructuredOutputClient;
    checkpointer?: BaseCheckpointSaver;
  }) {
    this.data = options?.data ?? new InMemoryHandoffDataLayer();
    this.graph = buildHandoffGraph(
      {
        data: this.data,
        agents: options?.agents ?? createFixtureAgents(options?.client),
      },
      options?.checkpointer ?? new MemorySaver(),
    );
  }

  /** Start a run and return its immutable candidate or failed version. */
  async generate(
    patient: Patient,
    events: ChartEvent[],
    generatedAt = new Date(),
    triggerEventId?: string,
  ): Promise<HandoffVersion> {
    if (this.data instanceof InMemoryHandoffDataLayer) this.data.setPatientEvents(patient, events);
    const trigger = triggerEventId ?? [...events].sort((left, right) =>
      right.recordedAt.localeCompare(left.recordedAt),
    )[0]?.id ?? "";
    const initial = withStateDefaults({
      patientId: patient.id,
      triggerEventId: trigger,
      generatedAt,
    });
    const result = await this.graph.invoke(initial, {
      configurable: { thread_id: initial.runId },
    });
    if (!result.versionId) {
      if (patient.isSynthetic !== true) {
        throw new HandoffPipelineError("NON_SYNTHETIC_PATIENT", "The graph only accepts synthetic patients.");
      }
      throw new HandoffPipelineError(
        result.failure?.code ?? "HANDOFF_VERSION_MISSING",
        result.failure?.message ?? "The graph ended without storing a handoff version.",
      );
    }
    if (result.status === "awaiting_review") {
      await this.data.registerReviewThread(result.versionId, initial.runId);
    }
    this.runByVersionId.set(result.versionId, initial.runId);
    const version = await this.data.get(result.versionId);
    if (!version) throw new HandoffPipelineError("HANDOFF_VERSION_MISSING", "The graph stored no retrievable handoff version.");
    return version;
  }

  /** Resume a paused review thread. Only this explicit decision can publish a candidate. */
  async resume(runId: string, decision: "approved" | "rejected"): Promise<HandoffGraphState> {
    return this.graph.invoke(new Command({ resume: decision }), {
      configurable: { thread_id: runId },
    });
  }

  /** Resume the in-memory review thread associated with a candidate returned by generate(). */
  async resumeVersion(
    versionId: string,
    decision: "approved" | "rejected",
  ): Promise<HandoffGraphState> {
    const runId = this.runByVersionId.get(versionId);
    if (!runId) {
      throw new HandoffPipelineError(
        "REVIEW_RUN_NOT_FOUND",
        "This candidate has no review thread in the current pipeline instance.",
      );
    }
    return this.resume(runId, decision);
  }

  async getCurrent(patientId: string): Promise<HandoffVersion | null> {
    const publications = await this.data.listPublications(patientId);
    const latest = publications.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0];
    if (!latest) return null;
    const version = await this.data.get(latest.handoffVersionId);
    return version ? { ...version, status: "published" } : null;
  }

  async listVersions(patientId: string): Promise<HandoffVersion[]> {
    return this.data.list(patientId);
  }

  async runState(runId: string, input: {
    patientId: string;
    triggerEventId: string;
    generatedAt?: Date;
    maxRetries?: number;
  }): Promise<HandoffGraphState> {
    const result = await this.graph.invoke(withStateDefaults({ ...input, runId }), {
      configurable: { thread_id: runId },
    });
    if (result.status === "awaiting_review" && result.versionId) {
      await this.data.registerReviewThread(result.versionId, runId);
    }
    return result;
  }
}
