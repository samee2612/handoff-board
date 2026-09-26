import { describe, expect, it } from "vitest";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { createVitalHandoffCandidate } from "@/lib/vitals/handoff";

describe("createVitalHandoffCandidate", () => {
  it("adds a schedule-aware handoff claim for the newly recorded vital", async () => {
    const unit = createDemoUnit();
    const patient = unit.patients[0];
    const recordedAt = new Date("2026-09-26T20:00:00.000Z").toISOString();
    const event = {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
      patientId: patient.id,
      category: "vital" as const,
      occurredAt: recordedAt,
      recordedAt,
      sourceLabel: "Fictional vital-sign record",
      payload: { systolicBloodPressure: 118, diastolicBloodPressure: 72 },
    };
    const result = await createVitalHandoffCandidate({
      patient,
      events: [...unit.chartEvents.filter((item) => item.patientId === patient.id), event],
      plans: unit.vitalMonitoringPlans.filter((plan) => plan.patientId === patient.id),
      recordedVital: event,
      generatedAt: new Date(recordedAt),
    });

    expect(result.candidate.status).toBe("candidate");
    expect(result.candidate.claims.some((claim) => claim.text.includes("BP 118/72 recorded") && claim.text.includes("Next BP check is due"))).toBe(true);
    expect(result.candidate.claims.find((claim) => claim.text.includes("BP 118/72"))?.evidenceEventIds).toContain(event.id);
  });
});
