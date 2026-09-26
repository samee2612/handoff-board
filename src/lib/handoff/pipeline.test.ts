import { describe, expect, it } from "vitest";
import type { ChartEvent, ExtractedFact, VerificationDecision } from "@/lib/contracts";
import { EvidenceVerifier, type SpecialistAgent, type SpecialistResult } from "@/lib/handoff/agents";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { createDemoUnit } from "@/lib/demo/seed-data";

class FailingSpecialist implements SpecialistAgent {
  readonly name = "chart_vitals" as const;
  readonly model = "failing-fixture";

  async extract(_events: ChartEvent[]): Promise<SpecialistResult> {
    throw new Error("Synthetic specialist outage");
  }
}

class SelectiveGapVerifier extends EvidenceVerifier {
  override async verify(
    claims: { id: string }[],
    _facts: ExtractedFact[],
    _events: ChartEvent[],
  ): Promise<VerificationDecision[]> {
    return claims.map((claim, index) => ({
      claimId: claim.id,
      status: index === 0 ? "supported" : "gap",
      reason: index === 0 ? "Synthetic support confirmed." : "Synthetic evidence gap.",
    }));
  }
}

describe("HandoffPipeline", () => {
  it("publishes only source-linked synthetic claims and records all agent diagnostics", async () => {
    const unit = createDemoUnit();
    const pipeline = new HandoffPipeline();
    const version = await pipeline.generate(unit.patients[0], unit.chartEvents.filter((event) => event.patientId === unit.patients[0].id), unit.now);

    expect(version.status).toBe("published");
    expect(version.claims).toHaveLength(4);
    expect(version.claims.every((claim) => claim.evidenceEventIds.length > 0)).toBe(true);
    expect(version.claims.some((claim) => claim.text.includes("40"))).toBe(false);
    expect(version.diagnostics.map((diagnostic) => diagnostic.agent)).toEqual([
      "chart_vitals",
      "medications",
      "tasks_incidents",
      "sbar_synthesizer",
      "evidence_verifier",
    ]);
    expect(version.diagnostics.every((diagnostic) => diagnostic.status === "succeeded")).toBe(true);
  });

  it("excludes unsupported claims while retaining supported evidence", async () => {
    const unit = createDemoUnit();
    const pipeline = new HandoffPipeline({ verifier: new SelectiveGapVerifier() });
    const version = await pipeline.generate(unit.patients[0], unit.chartEvents.filter((event) => event.patientId === unit.patients[0].id), unit.now);

    expect(version.status).toBe("published");
    expect(version.claims).toHaveLength(1);
    expect(version.excludedClaims).toHaveLength(3);
  });

  it("fails closed and persists the diagnostic when a specialist fails", async () => {
    const unit = createDemoUnit();
    const pipeline = new HandoffPipeline({ specialists: [new FailingSpecialist()] });
    const version = await pipeline.generate(unit.patients[0], unit.chartEvents.filter((event) => event.patientId === unit.patients[0].id), unit.now);

    expect(version).toMatchObject({
      status: "failed",
      claims: [],
      failure: { code: "AGENT_FAILURE", message: "Synthetic specialist outage" },
    });
    expect(version.diagnostics).toHaveLength(1);
    expect(version.diagnostics[0]).toMatchObject({ agent: "chart_vitals", status: "failed" });
  });

  it("rejects non-synthetic records before any agent receives them", async () => {
    const unit = createDemoUnit();
    const nonSyntheticPatient = { ...unit.patients[0], isSynthetic: false } as unknown as typeof unit.patients[number];
    const pipeline = new HandoffPipeline();

    await expect(pipeline.generate(nonSyntheticPatient, [], unit.now)).rejects.toMatchObject({
      code: "NON_SYNTHETIC_OR_INVALID_PATIENT",
    });
  });

  it("persists a failed version when runtime chart input violates its contract", async () => {
    const unit = createDemoUnit();
    const invalidEvents = [{ id: "not-a-uuid" }] as unknown as ChartEvent[];
    const pipeline = new HandoffPipeline();
    const version = await pipeline.generate(unit.patients[0], invalidEvents, unit.now);

    expect(version).toMatchObject({
      status: "failed",
      failure: { code: "INVALID_CHART_EVENTS" },
    });
  });

  it("keeps version history append-only even when a caller mutates a returned snapshot", async () => {
    const unit = createDemoUnit();
    const events = unit.chartEvents.filter((event) => event.patientId === unit.patients[0].id);
    const pipeline = new HandoffPipeline();
    const first = await pipeline.generate(unit.patients[0], events, unit.now);
    first.claims[0].text = "caller mutation";
    const second = await pipeline.generate(unit.patients[0], events, new Date(unit.now.getTime() + 1_000));

    const versions = pipeline.listVersions(unit.patients[0].id);
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    expect(versions[0].claims[0].text).not.toBe("caller mutation");
    expect(pipeline.getCurrent(unit.patients[0].id)?.id).toBe(second.id);
  });
});
