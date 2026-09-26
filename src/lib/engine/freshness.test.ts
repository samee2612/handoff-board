import { describe, expect, it } from "vitest";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { evaluateFreshness } from "@/lib/engine/freshness";

describe("evaluateFreshness", () => {
  it("marks a complete, current chart green", () => {
    const unit = createDemoUnit();
    const avaEvents = unit.chartEvents.filter((event) => event.patientId === unit.patients[0].id);
    expect(evaluateFreshness(avaEvents, unit.now)).toMatchObject({ status: "green" });
  });

  it("marks missing required source categories red", () => {
    const unit = createDemoUnit();
    const claraEvents = unit.chartEvents.filter((event) => event.patientId === unit.patients[2].id);
    expect(evaluateFreshness(claraEvents, unit.now)).toMatchObject({
      status: "red",
      missingCategories: ["nursing_note", "medication", "task"],
    });
  });

  it("marks a complete chart amber when a required source is older than the demo threshold", () => {
    const unit = createDemoUnit();
    const avaEvents = unit.chartEvents.filter((event) => event.patientId === unit.patients[0].id);
    expect(evaluateFreshness(avaEvents, new Date(unit.now.getTime() + 8 * 60 * 60_000))).toMatchObject({
      status: "amber",
      staleCategories: ["nursing_note", "vital"],
    });
  });
});
