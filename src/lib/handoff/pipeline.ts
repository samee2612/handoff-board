import { randomUUID } from "node:crypto";
import type {
  AgentDiagnostic,
  ChartEvent,
  HandoffClaim,
  HandoffVersion,
  Patient,
  SpecialistName,
} from "@/lib/contracts";
import { chartEventSchema, patientSchema } from "@/lib/contracts";
import {
  ChartVitalsSpecialist,
  EvidenceVerifier,
  MedicationSpecialist,
  SbarSynthesizer,
  TasksIncidentsSpecialist,
  type SpecialistAgent,
} from "@/lib/handoff/agents";
import { HandoffPipelineError, toPipelineError } from "@/lib/handoff/errors";
import type { StructuredOutputClient } from "@/lib/handoff/structured-output";
import {
  failedVersionDraft,
  InMemoryHandoffVersionStore,
  publishedVersionDraft,
  type HandoffVersionStore,
} from "@/lib/handoff/version-store";

type AgentName = SpecialistName | "sbar_synthesizer" | "evidence_verifier";
type AgentRun<T> = { value?: T; diagnostic: AgentDiagnostic };

function sourceEventCutoff(events: ChartEvent[], fallback: Date): string {
  const latest = events.reduce<Date>((current, event) => {
    const recordedAt = new Date(event.recordedAt);
    return recordedAt > current ? recordedAt : current;
  }, new Date(0));
  return (latest.getTime() === 0 ? fallback : latest).toISOString();
}

async function runAgent<T>(input: {
  runId: string;
  agent: AgentName;
  model: string;
  inputEventCount: number;
  operation: () => Promise<T>;
  outputCount: (result: T) => number;
}): Promise<AgentRun<T>> {
  const started = new Date();
  try {
    const value = await input.operation();
    return {
      value,
      diagnostic: {
        runId: input.runId,
        agent: input.agent,
        status: "succeeded",
        model: input.model,
        startedAt: started.toISOString(),
        completedAt: new Date().toISOString(),
        inputEventCount: input.inputEventCount,
        outputCount: input.outputCount(value),
      },
    };
  } catch (error) {
    const failure = toPipelineError(error, "AGENT_FAILURE");
    return {
      diagnostic: {
        runId: input.runId,
        agent: input.agent,
        status: "failed",
        model: input.model,
        startedAt: started.toISOString(),
        completedAt: new Date().toISOString(),
        inputEventCount: input.inputEventCount,
        outputCount: 0,
        errorCode: failure.code,
        errorMessage: failure.message,
      },
    };
  }
}

export class HandoffPipeline {
  private readonly specialists: SpecialistAgent[];
  private readonly synthesizer: SbarSynthesizer;
  private readonly verifier: EvidenceVerifier;
  private readonly store: HandoffVersionStore;

  constructor(options?: {
    client?: StructuredOutputClient;
    store?: HandoffVersionStore;
    specialists?: SpecialistAgent[];
    synthesizer?: SbarSynthesizer;
    verifier?: EvidenceVerifier;
  }) {
    const client = options?.client;
    this.specialists = options?.specialists ?? [
      new ChartVitalsSpecialist(client),
      new MedicationSpecialist(client),
      new TasksIncidentsSpecialist(client),
    ];
    this.synthesizer = options?.synthesizer ?? new SbarSynthesizer(client);
    this.verifier = options?.verifier ?? new EvidenceVerifier(client);
    this.store = options?.store ?? new InMemoryHandoffVersionStore();
  }

  async generate(patient: Patient, events: ChartEvent[], generatedAt = new Date()): Promise<HandoffVersion> {
    const validatedPatient = patientSchema.safeParse(patient);
    if (!validatedPatient.success) {
      throw new HandoffPipelineError("NON_SYNTHETIC_OR_INVALID_PATIENT", "The Step 2 pipeline accepts synthetic patient records only.");
    }
    const validatedEvents = chartEventSchema.array().safeParse(events);
    if (!validatedEvents.success) {
      return this.store.append(
        failedVersionDraft({
          patientId: validatedPatient.data.id,
          sourceEventCutoff: generatedAt.toISOString(),
          generatedAt: generatedAt.toISOString(),
          model: this.synthesizer.model,
          diagnostics: [],
          failure: { code: "INVALID_CHART_EVENTS", message: "Chart events did not satisfy the synthetic data contract." },
        }),
      );
    }

    const runId = randomUUID();
    const diagnostics: AgentDiagnostic[] = [];
    const patientEvents = validatedEvents.data.filter((event) => event.patientId === validatedPatient.data.id);
    const createdAt = generatedAt.toISOString();
    const cutoff = sourceEventCutoff(patientEvents, generatedAt);
    const model = this.synthesizer.model;

    if (validatedEvents.data.length !== patientEvents.length) {
      return this.store.append(
        failedVersionDraft({
          patientId: validatedPatient.data.id,
          sourceEventCutoff: cutoff,
          generatedAt: createdAt,
          model,
          diagnostics,
          failure: { code: "MIXED_PATIENT_EVENTS", message: "A handoff run may only contain events for one patient." },
        }),
      );
    }

    const specialistRuns = await Promise.all(
      this.specialists.map((specialist) =>
        runAgent({
          runId,
          agent: specialist.name,
          model: specialist.model,
          inputEventCount: patientEvents.length,
          operation: () => specialist.extract(patientEvents),
          outputCount: (result) => result.facts.length,
        }),
      ),
    );
    diagnostics.push(...specialistRuns.map((result) => result.diagnostic));

    const failedSpecialist = specialistRuns.find((result) => result.value === undefined);
    if (failedSpecialist) {
      return this.store.append(
        failedVersionDraft({
          patientId: validatedPatient.data.id,
          sourceEventCutoff: cutoff,
          generatedAt: createdAt,
          model,
          diagnostics,
          failure: {
            code: failedSpecialist.diagnostic.errorCode ?? "SPECIALIST_FAILURE",
            message: failedSpecialist.diagnostic.errorMessage ?? "A specialist did not return a result.",
          },
        }),
      );
    }

    const facts = specialistRuns.flatMap((result) => result.value!.facts);
    const synthesisRun = await runAgent({
      runId,
      agent: "sbar_synthesizer",
      model: this.synthesizer.model,
      inputEventCount: new Set(facts.flatMap((fact) => fact.evidenceEventIds)).size,
      operation: () => this.synthesizer.synthesize(facts, patientEvents),
      outputCount: (claims) => claims.length,
    });
    diagnostics.push(synthesisRun.diagnostic);
    if (!synthesisRun.value) {
      return this.store.append(
        failedVersionDraft({
          patientId: validatedPatient.data.id,
          sourceEventCutoff: cutoff,
          generatedAt: createdAt,
          model,
          diagnostics,
          failure: {
            code: synthesisRun.diagnostic.errorCode ?? "SYNTHESIS_FAILURE",
            message: synthesisRun.diagnostic.errorMessage ?? "The synthesizer did not return a result.",
          },
        }),
      );
    }

    const verifierRun = await runAgent({
      runId,
      agent: "evidence_verifier",
      model: this.verifier.model,
      inputEventCount: patientEvents.length,
      operation: () => this.verifier.verify(synthesisRun.value!, facts, patientEvents),
      outputCount: (decisions) => decisions.length,
    });
    diagnostics.push(verifierRun.diagnostic);
    if (!verifierRun.value) {
      return this.store.append(
        failedVersionDraft({
          patientId: validatedPatient.data.id,
          sourceEventCutoff: cutoff,
          generatedAt: createdAt,
          model,
          diagnostics,
          failure: {
            code: verifierRun.diagnostic.errorCode ?? "VERIFICATION_FAILURE",
            message: verifierRun.diagnostic.errorMessage ?? "The evidence verifier did not return a result.",
          },
        }),
      );
    }

    const decisions = new Map(verifierRun.value.map((decision) => [decision.claimId, decision]));
    const claims: HandoffClaim[] = [];
    const excludedClaims: HandoffVersion["excludedClaims"] = [];
    for (const claim of synthesisRun.value) {
      const decision = decisions.get(claim.id);
      if (decision?.status === "supported") claims.push(claim);
      else excludedClaims.push({ claim, reason: decision?.reason ?? "The verifier returned no decision for this claim." });
    }

    if (claims.length === 0) {
      return this.store.append(
        failedVersionDraft({
          patientId: validatedPatient.data.id,
          sourceEventCutoff: cutoff,
          generatedAt: createdAt,
          model,
          diagnostics,
          failure: { code: "NO_SUPPORTED_CLAIMS", message: "No evidence-supported claims are available to publish." },
        }),
      );
    }

    return this.store.append(
      publishedVersionDraft({
        patientId: validatedPatient.data.id,
        sourceEventCutoff: cutoff,
        generatedAt: createdAt,
        model,
        diagnostics,
        claims,
        excludedClaims,
      }),
    );
  }

  getCurrent(patientId: string): HandoffVersion | null {
    return this.store.current(patientId);
  }

  listVersions(patientId: string): HandoffVersion[] {
    return this.store.list(patientId);
  }
}
