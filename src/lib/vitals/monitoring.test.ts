import { describe, expect, it } from "vitest";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { evaluateVitalMonitoring } from "@/lib/vitals/monitoring";

describe("evaluateVitalMonitoring", () => {
  it("uses the latest matching reading to calculate the next due time", () => {
    const unit = createDemoUnit();
    const plan = unit.vitalMonitoringPlans.find((item) => item.patientId === unit.patients[0].id && item.vitalType === "blood_pressure");
    expect(plan).toBeDefined();
    const status = evaluateVitalMonitoring(unit.chartEvents, plan!);
    expect(status.displayValue).toBe("128/76");
    expect(status.nextDueAt).toBe(new Date(unit.now.getTime() - 44 * 60_000 + 4 * 60 * 60_000).toISOString());
    expect(status.attention).toBe("routine");
  });

  it("uses configured synthetic bounds instead of agent interpretation", () => {
    const unit = createDemoUnit();
    const plan = unit.vitalMonitoringPlans.find((item) => item.patientId === unit.patients[1].id && item.vitalType === "blood_pressure");
    expect(plan).toBeDefined();
    const status = evaluateVitalMonitoring([
      ...unit.chartEvents,
      {
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
        patientId: unit.patients[1].id,
        category: "vital" as const,
        occurredAt: unit.now.toISOString(),
        recordedAt: unit.now.toISOString(),
        sourceLabel: "Fictional vital-sign record",
        payload: { systolicBloodPressure: 82, diastolicBloodPressure: 54 },
      },
    ], plan!);
    expect(status.attention).toBe("urgent");
  });
});
