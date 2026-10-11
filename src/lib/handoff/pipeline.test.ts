import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChartEvent, ExtractedFact, VerificationDecision } from "@/lib/contracts";
import {
  ChartVitalsSpecialist,
  EvidenceVerifier,
  MedicationSpecialist,
  SbarSynthesizer,
  TasksIncidentsSpecialist,
  type HandoffSynthesisContext,
  type SpecialistAgent,
  type SpecialistResult,
} from "@/lib/handoff/agents";
import { InMemoryHandoffDataLayer } from "@/lib/handoff/data-layer";
import { HandoffPipeline, type HandoffAgents } from "@/lib/handoff/pipeline";
import { createDemoUnit } from "@/lib/demo/seed-data";

class FailingSpecialist implements SpecialistAgent {
  readonly name = "chart_vitals" as const;
  readonly model = "failing-fixture";

  async extract(_events: ChartEvent[]): Promise<SpecialistResult> {
    throw new Error("Synthetic specialist outage");
  }
}

class GapThenSupportVerifier extends EvidenceVerifier {
  calls = 0;

  override async verify(claims: { id: string }[]): Promise<VerificationDecision[]> {
    this.calls += 1;
    return claims.map((claim) => ({
      claimId: claim.id,
      status: this.calls === 1 ? "gap" : "supported",
      reason: this.calls === 1 ? "Synthetic evidence gap." : "Synthetic support confirmed.",
    }));
  }
}

class AlwaysGapVerifier extends EvidenceVerifier {
  calls = 0;

  override async verify(claims: { id: string }[]): Promise<VerificationDecision[]> {
    this.calls += 1;
    return claims.map((claim) => ({
      claimId: claim.id,
      status: "gap",
      reason: "Synthetic evidence gap.",
    }));
  }
}

class ContextCapturingSynthesizer extends SbarSynthesizer {
  context: HandoffSynthesisContext | undefined;

  override async synthesize(
    facts: ExtractedFact[],
    events: ChartEvent[],
    context?: HandoffSynthesisContext,
  ) {
    this.context = context;
    return super.synthesize(facts, events, context);
  }
}

class InvalidEvidenceSynthesizer extends SbarSynthesizer {
  override async synthesize() {
    return [{
      id: "unsupported",
      section: "assessment" as const,
      text: "Unsupported claim",
      evidenceEventIds: ["99999999-9999-4999-8999-999999999999"],
    }];
  }
}

function createHarness(overrides: Partial<HandoffAgents> = {}) {
  const unit = createDemoUnit();
  const patient = unit.patients[0];
  const data = new InMemoryHandoffDataLayer(unit);
  const agents: HandoffAgents = {
    specialists: {
      chart_vitals: new ChartVitalsSpecialist(),
      medications: new MedicationSpecialist(),
      tasks_incidents: new TasksIncidentsSpecialist(),
      ...overrides.specialists,
    },
    synthesizer: overrides.synthesizer ?? new SbarSynthesizer(),
    verifier: overrides.verifier ?? new EvidenceVerifier(),
  };
  return {
    data,
    patient,
    pipeline: new HandoffPipeline({ data, agents }),
    runId: randomUUID(),
    triggerEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    generatedAt: unit.now,
  };
}

async function startRun(harness: ReturnType<typeof createHarness>) {
  return harness.pipeline.runState(harness.runId, {
    patientId: harness.patient.id,
    triggerEventId: harness.triggerEventId,
    generatedAt: harness.generatedAt,
  });
}

describe("LangGraph handoff pipeline with offline fixtures", () => {
  it("creates an immutable candidate and waits for explicit approval before publication", async () => {
    const harness = createHarness();
    const candidate = await harness.pipeline.generate(
      harness.patient,
      await harness.data.getEvents(harness.patient.id),
      harness.generatedAt,
      harness.triggerEventId,
    );
    const versions = await harness.data.list(harness.patient.id);

    expect(candidate.status).toBe("candidate");
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe("candidate");
    expect(versions[0].claims.length).toBeGreaterThan(0);
    expect(versions[0].claims.every((claim) => claim.evidenceEventIds.length > 0)).toBe(true);
    expect(await harness.data.listPublications(harness.patient.id)).toHaveLength(0);

    const resumed = await harness.pipeline.resumeVersion(candidate.id, "approved");
    expect(resumed.status).toBe("published");
    expect((await harness.data.get(versions[0].id))?.status).toBe("candidate");
    expect(await harness.data.listPublications(harness.patient.id)).toMatchObject([
      { handoffVersionId: versions[0].id },
    ]);
  });

  it("re-synthesizes once after a verifier gap, then reaches human review", async () => {
    const verifier = new GapThenSupportVerifier();
    const harness = createHarness({ verifier });
    const paused = await startRun(harness);

    expect(paused.status).toBe("awaiting_review");
    expect(paused.retryCount).toBe(1);
    expect(paused.gapFeedback).toEqual([]);
    expect(verifier.calls).toBe(2);
    expect((await harness.data.list(harness.patient.id))[0].status).toBe("candidate");
  });

  it("writes a failed version when a gap remains after the retry limit", async () => {
    const verifier = new AlwaysGapVerifier();
    const harness = createHarness({ verifier });
    const state = await startRun(harness);

    expect(state.status).toBe("failed");
    expect(verifier.calls).toBe(2);
    await expect(harness.data.list(harness.patient.id)).resolves.toMatchObject([
      { status: "failed", claims: [], excludedClaims: expect.arrayContaining([expect.anything()]) },
    ]);
  });

  it("writes a failed version when a parallel specialist fails", async () => {
    const harness = createHarness({
      specialists: { chart_vitals: new FailingSpecialist() },
    });
    const state = await startRun(harness);

    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({ code: "AGENT_FAILURE", message: "Synthetic specialist outage" });
    await expect(harness.data.list(harness.patient.id)).resolves.toMatchObject([
      { status: "failed", diagnostics: expect.arrayContaining([expect.objectContaining({ status: "failed" })]) },
    ]);
  });

  it("rejects non-synthetic patients before persisting a version", async () => {
    const harness = createHarness();
    const nonSyntheticPatient = structuredClone(harness.patient);
    Reflect.set(nonSyntheticPatient, "isSynthetic", false);
    harness.data.setPatientEvents(nonSyntheticPatient, []);

    const state = await startRun(harness);

    expect(state.status).toBe("rejected");
    expect(state.failure?.code).toBe("NON_SYNTHETIC_PATIENT");
    expect(await harness.data.list(harness.patient.id)).toHaveLength(0);
  });

  it("resumes a rejected review without appending a publication event", async () => {
    const harness = createHarness();
    const paused = await startRun(harness);
    const candidateId = paused.versionId;

    const resumed = await harness.pipeline.resume(harness.runId, "rejected");
    expect(resumed.status).toBe("rejected");
    expect(await harness.data.get(candidateId!)).toMatchObject({ status: "candidate" });
    expect(await harness.data.listPublications(harness.patient.id)).toHaveLength(0);
  });

  it("computes monitoring attention and due time outside the synthesizer", async () => {
    const synthesizer = new ContextCapturingSynthesizer();
    const harness = createHarness({ synthesizer });
    const paused = await startRun(harness);
    const vital = (await harness.data.getEvents(harness.patient.id)).find(
      (event) => event.id === harness.triggerEventId && event.category === "vital",
    );

    expect(paused.attention).toBe("routine");
    expect(paused.nextDueAt).toBe(
      new Date(new Date(vital!.recordedAt).getTime() + 240 * 60_000).toISOString(),
    );
    expect(synthesizer.context?.attention).toBe("routine");
    expect(synthesizer.context?.nextDueAt).toBe(paused.nextDueAt);
    expect((await harness.data.list(harness.patient.id))[0]).not.toHaveProperty("attention");
  });

  it("fails closed when a claim cites an event not present in specialist facts", async () => {
    const harness = createHarness({ synthesizer: new InvalidEvidenceSynthesizer() });
    const state = await startRun(harness);

    expect(state.status).toBe("failed");
    expect(state.failure?.code).toBe("NO_SUPPORTED_CLAIMS");
    expect((await harness.data.list(harness.patient.id))[0].status).toBe("failed");
  });
});
