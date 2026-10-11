import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import type {
  ChartEvent,
  HandoffClaim,
  Patient,
  VitalMonitoringPlan,
} from "@/lib/contracts";
import {
  ChartVitalsSpecialist,
  EvidenceVerifier,
  MedicationSpecialist,
  SbarSynthesizer,
  TasksIncidentsSpecialist,
} from "@/lib/handoff/agents";
import { InMemoryHandoffDataLayer } from "@/lib/handoff/data-layer";
import type { HandoffGraphState } from "@/lib/handoff/pipeline";
import { buildHandoffGraph } from "@/lib/handoff/pipeline";
import { ScriptedLlm, type LlmNode } from "./scripted-llm";

const FIXTURE_DAY = "2026-10-11";
const DEMO_UNIT_ID = "11111111-1111-4111-8111-111111111111";
const DEMO_NURSE_ID = "22222222-2222-4222-8222-222222222222";

const timestamp = (hour: number, minute: number): string =>
  `${FIXTURE_DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

export function makePatient(): Patient {
  return {
    id: "pt-4",
    unitId: DEMO_UNIT_ID,
    isSynthetic: true,
    displayName: "Fictional Patient Four",
    room: "TEST-4",
    assignedNurseId: DEMO_NURSE_ID,
    admittedAt: timestamp(8, 0),
  };
}

export function makeChartEvents(patientId = "pt-4"): ChartEvent[] {
  return [
    {
      id: "evt-901",
      patientId,
      category: "vital",
      occurredAt: timestamp(16, 0),
      recordedAt: timestamp(16, 0),
      sourceLabel: "Synthetic vital fixture",
      payload: { systolicBloodPressure: 88, diastolicBloodPressure: 54 },
    },
    {
      id: "evt-902",
      patientId,
      category: "nursing_note",
      occurredAt: timestamp(16, 30),
      recordedAt: timestamp(16, 30),
      sourceLabel: "Synthetic nursing note fixture",
      payload: { summary: "Patient says feeling dizzy" },
    },
    {
      id: "evt-903",
      patientId,
      category: "medication",
      occurredAt: timestamp(16, 35),
      recordedAt: timestamp(16, 35),
      sourceLabel: "Synthetic medication fixture",
      payload: {
        medicationName: "Fictional Medication A",
        dose: "1 tablet",
        route: "oral",
        scheduleType: "scheduled",
        dueAt: timestamp(17, 0),
        status: "active",
      },
    },
    {
      id: "evt-904",
      patientId,
      category: "medication",
      occurredAt: timestamp(16, 40),
      recordedAt: timestamp(16, 40),
      sourceLabel: "Synthetic medication fixture",
      payload: {
        medicationName: "Fictional Medication B",
        dose: "2 mL",
        route: "oral",
        scheduleType: "prn",
        nextEligibleAt: timestamp(18, 0),
        status: "active",
      },
    },
    {
      id: "evt-905",
      patientId,
      category: "task",
      occurredAt: timestamp(17, 0),
      recordedAt: timestamp(17, 0),
      sourceLabel: "Synthetic task fixture",
      payload: {
        title: "Recheck BP before 5 pm",
        dueAt: timestamp(17, 0),
        status: "open",
      },
    },
  ];
}

export function makeMonitoringPlan(patientId = "pt-4"): VitalMonitoringPlan {
  return {
    id: "77777777-7777-4777-8777-777777777771",
    patientId,
    vitalType: "blood_pressure",
    urgentBelow: 90,
    attentionBelow: 100,
    intervalMinutes: 60,
  };
}

class FixtureDataLayer extends InMemoryHandoffDataLayer {
  constructor(
    patient: Patient,
    events: ChartEvent[],
    private readonly plan: VitalMonitoringPlan,
    private readonly protocolChunks?: Array<{ id: string; text: string }>,
  ) {
    super();
    this.setPatientEvents(patient, events);
  }

  override async getPlan(patientId: string, triggerEventId: string): Promise<VitalMonitoringPlan | null> {
    return patientId === this.plan.patientId && triggerEventId === "evt-901"
      ? structuredClone(this.plan)
      : null;
  }

  override async retrieve(_query: string, limit: number) {
    if (!this.protocolChunks) return super.retrieve(_query, limit);
    return structuredClone(this.protocolChunks.slice(0, Math.min(3, Math.max(0, limit))));
  }
}

function defaultResponse(nodeName: LlmNode, input: unknown): unknown {
  const value = input as {
    events?: ChartEvent[];
    facts?: Array<{ summary: string; evidenceEventIds: string[] }>;
    claims?: Array<{ id: string }>;
  };

  if (nodeName === "chart_vitals" || nodeName === "medications" || nodeName === "tasks_incidents") {
    return {
      facts: (value.events ?? []).map((event) => ({
        summary: summarize(event),
        evidenceEventIds: [event.id],
      })),
    };
  }

  if (nodeName === "synthesize_sbar") {
    return {
      claims: (value.facts ?? []).map((fact) => ({
        section: "assessment",
        text: fact.summary,
        evidenceEventIds: fact.evidenceEventIds,
      })),
    };
  }

  return {
    decisions: (value.claims ?? []).map((claim) => ({
      claimId: claim.id,
      status: "supported",
      reason: "The scripted fixture supports the claim.",
    })),
  };
}

function summarize(event: ChartEvent): string {
  switch (event.category) {
    case "vital":
      return `Systolic BP ${event.payload.systolicBloodPressure}; diastolic BP ${event.payload.diastolicBloodPressure}`;
    case "nursing_note":
      return event.payload.summary;
    case "medication":
      return `${event.payload.medicationName} ${event.payload.dose} ${event.payload.route}`;
    case "task":
      return event.payload.title;
    case "incident":
      return event.payload.description;
  }
}

export type GraphTestInput = HandoffGraphState;

export function makeGraph(options: {
  patient?: Patient;
  events?: ChartEvent[];
  plan?: VitalMonitoringPlan;
  protocolChunks?: Array<{ id: string; text: string }>;
  maxRetries?: number;
} = {}) {
  const patient = options.patient ?? makePatient();
  const events = options.events ?? makeChartEvents(patient.id);
  const plan = options.plan ?? makeMonitoringPlan(patient.id);
  const data = new FixtureDataLayer(patient, events, plan, options.protocolChunks);
  const llm = new ScriptedLlm(defaultResponse);
  const checkpointer = new MemorySaver();
  const graph = buildHandoffGraph(
    {
      data,
      agents: {
        specialists: {
          chart_vitals: new ChartVitalsSpecialist(llm),
          medications: new MedicationSpecialist(llm),
          tasks_incidents: new TasksIncidentsSpecialist(llm),
        },
        synthesizer: new SbarSynthesizer(llm),
        verifier: new EvidenceVerifier(llm),
      },
    },
    checkpointer,
  );
  const input: GraphTestInput = {
    patientId: patient.id,
    triggerEventId: "evt-901",
    runId: randomUUID(),
    generatedAt: timestamp(17, 5),
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
    maxRetries: options.maxRetries ?? 1,
    gapFeedback: [],
    supportedClaims: [],
    excludedClaims: [],
    diagnostics: [],
    versionId: null,
    reviewDecision: null,
    status: "running",
    failure: null,
  };
  return { graph, data, llm, checkpointer, patient, events, plan, input };
}

export function makeClaim(input: {
  id?: string;
  text: string;
  evidenceEventIds: string[];
  evidenceProtocolChunkIds?: string[];
}): HandoffClaim {
  return {
    id: input.id ?? "claim-scripted",
    section: "assessment",
    text: input.text,
    evidenceEventIds: input.evidenceEventIds,
    ...(input.evidenceProtocolChunkIds
      ? { evidenceProtocolChunkIds: input.evidenceProtocolChunkIds }
      : {}),
  };
}
