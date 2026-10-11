import { describe, expect, it } from "vitest";
import type { ChartEvent, VitalMonitoringPlan } from "@/lib/contracts";
import { evaluateHandoffRules } from "@/lib/engine/handoff-rules";

const PATIENT_ID = "pt-4";
const DAY = "2026-10-11";

function at(hour: number, minute = 0): string {
  return `${DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

function bloodPressureReadings(values: number[]): Extract<ChartEvent, { category: "vital" }>[] {
  const times = [9, 11, 13, 16];
  return values.map((systolic, index) => ({
    id: `evt-${901 + index}`,
    patientId: PATIENT_ID,
    category: "vital" as const,
    occurredAt: at(times[index]),
    recordedAt: at(times[index]),
    sourceLabel: "Synthetic BP fixture",
    payload: { systolicBloodPressure: systolic, diastolicBloodPressure: 70 },
  }));
}

function plan(overrides: Partial<VitalMonitoringPlan> = {}): VitalMonitoringPlan {
  return {
    id: "77777777-7777-4777-8777-777777777771",
    patientId: PATIENT_ID,
    vitalType: "blood_pressure",
    intervalMinutes: 60,
    urgentBelow: 90,
    attentionBelow: 100,
    ...overrides,
  };
}

describe("deterministic handoff trend, plausibility, and task rules", () => {
  it("emits a systolic trend for 122/78, 110/70, 98/60, 88/54", () => {
    const events = bloodPressureReadings([122, 110, 98, 88]).map((event, index) => ({
      ...event,
      payload: {
        systolicBloodPressure: [122, 110, 98, 88][index],
        diastolicBloodPressure: [78, 70, 60, 54][index],
      },
    }));
    const result = evaluateHandoffRules(events, plan(), new Date(at(17)));

    expect(result.trendFacts).toHaveLength(1);
    expect(result.trendFacts[0].summary).toContain("decreased from 122 to 88");
    expect(result.trendFacts[0].evidenceEventIds).toEqual(["evt-901", "evt-902", "evt-903", "evt-904"]);
  });

  it("does not emit a trend for a systolic drop of 10", () => {
    const result = evaluateHandoffRules(
      bloodPressureReadings([122, 120, 117, 112]),
      plan(),
      new Date(at(17)),
    );

    expect(result.trendFacts).toEqual([]);
  });

  it("flags an implausible systolic value of 1040", () => {
    const events = bloodPressureReadings([1040]);
    const result = evaluateHandoffRules(events, plan(), new Date(at(17)));

    expect(result.flags).toEqual([
      expect.objectContaining({
        kind: "data_quality",
        evidenceEventIds: ["evt-901"],
      }),
    ]);
  });

  it("detects an overdue task only when no completion event exists", () => {
    const openTask: ChartEvent = {
      id: "evt-905",
      patientId: PATIENT_ID,
      category: "task",
      occurredAt: at(11),
      recordedAt: at(11),
      sourceLabel: "Synthetic task fixture",
      payload: { title: "Recheck BP", dueAt: at(12), status: "open" },
    };
    const completion: ChartEvent = {
      ...openTask,
      id: "evt-906",
      occurredAt: at(12, 30),
      recordedAt: at(12, 30),
      payload: { title: "Recheck BP", dueAt: at(12), status: "completed" },
    };

    expect(evaluateHandoffRules([openTask], null, new Date(at(13))).flags).toEqual([
      expect.objectContaining({ kind: "overdue_task", evidenceEventIds: ["evt-905"] }),
    ]);
    expect(evaluateHandoffRules([openTask, completion], null, new Date(at(13))).flags).toEqual([]);
  });

  it("excludes a flagged value from urgency and trends", () => {
    const events = bloodPressureReadings([122, 110, 98, 1040]);
    const result = evaluateHandoffRules(events, plan(), new Date(at(17)));

    expect(result.attention).toBe("attention");
    expect(result.nextDueAt).toBe(at(14));
    expect(result.trendFacts).toEqual([]);
    expect(result.flags).toEqual([
      expect.objectContaining({
        kind: "data_quality",
        evidenceEventIds: ["evt-904"],
      }),
      expect.objectContaining({
        kind: "urgent_attention",
        evidenceEventIds: ["evt-903"],
      }),
    ]);
  });

  it("excludes a blood pressure reading when its diastolic value is implausible", () => {
    const [event] = bloodPressureReadings([88]);
    const result = evaluateHandoffRules(
      [{ ...event, payload: { systolicBloodPressure: 88, diastolicBloodPressure: 1000 } }],
      plan(),
      new Date(at(17)),
    );

    expect(result.attention).toBeNull();
    expect(result.observations).toEqual([]);
    expect(result.flags).toEqual([
      expect.objectContaining({ kind: "data_quality", evidenceEventIds: ["evt-901"] }),
    ]);
  });

  it("flags nursing notes that cannot be parsed into a vital", () => {
    const note: ChartEvent = {
      id: "evt-910",
      patientId: PATIENT_ID,
      category: "nursing_note",
      occurredAt: at(17, 15),
      recordedAt: at(17, 15),
      sourceLabel: "Synthetic nursing note fixture",
      payload: { summary: "BP 1O4/6O" },
    };
    const result = evaluateHandoffRules([note], null, new Date(at(18)));

    expect(result.flags).toEqual([
      expect.objectContaining({
        kind: "data_quality",
        evidenceEventIds: ["evt-910"],
      }),
    ]);
    expect(result.observations).toEqual([]);
  });

  it("emits a heart-rate trend when the rise reaches 20", () => {
    const events: ChartEvent[] = [80, 85, 91, 101].map((heartRate, index) => ({
      id: `evt-${920 + index}`,
      patientId: PATIENT_ID,
      category: "vital",
      occurredAt: at([9, 11, 13, 16][index]),
      recordedAt: at([9, 11, 13, 16][index]),
      sourceLabel: "Synthetic heart-rate fixture",
      payload: { heartRate },
    }));
    const result = evaluateHandoffRules(events, null, new Date(at(17)));

    expect(result.trendFacts).toHaveLength(1);
    expect(result.trendFacts[0].summary).toContain("increased from 80 to 101");
  });
});
