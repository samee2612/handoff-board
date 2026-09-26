import { describe, expect, it } from "vitest";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { compareHandoffVersions } from "@/lib/handoff/comparison";
import { HandoffPipeline } from "@/lib/handoff/pipeline";

describe("handoff comparison", () => {
  it("shows changed SBAR sentences as evidence-neutral additions and removals", async () => {
    const unit = createDemoUnit();
    const patient = unit.patients[0];
    const events = unit.chartEvents.filter((event) => event.patientId === patient.id);
    const published = await new HandoffPipeline().generate(patient, events, unit.now);
    const candidate = {
      ...published,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
      versionNumber: 2,
      status: "candidate" as const,
      claims: published.claims.map((claim, index) => index === 0 ? { ...claim, text: "Reworded fictional summary." } : claim),
    };

    const changes = compareHandoffVersions(published, candidate);

    expect(changes.map((change) => change.kind)).toEqual(["added", "removed"]);
    expect(changes.every((change) => change.claim.evidenceEventIds.length > 0)).toBe(true);
  });
});
