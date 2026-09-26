import { describe, expect, it } from "vitest";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { applyCandidateVersion, applySourceEvent, createLiveBoardState, isHandoffStale } from "@/lib/board/live-board";

describe("live board state", () => {
  it("marks a tile stale and recomputes deterministic alerts when a newer source event arrives", async () => {
    const unit = createDemoUnit();
    const patient = unit.patients[0];
    const events = unit.chartEvents.filter((event) => event.patientId === patient.id);
    const handoff = await new HandoffPipeline().generate(patient, events, unit.now);
    const state = createLiveBoardState({ patients: [patient], events, handoffs: [handoff], now: unit.now });
    const event = {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      patientId: patient.id,
      category: "task" as const,
      occurredAt: new Date(unit.now.getTime() + 1_000).toISOString(),
      recordedAt: new Date(unit.now.getTime() + 1_000).toISOString(),
      sourceLabel: "Fictional care task list",
      payload: { title: "Fictional new task", dueAt: new Date(unit.now.getTime() + 10 * 60_000).toISOString(), status: "open" as const },
    };

    const next = applySourceEvent(state, event, new Date(unit.now.getTime() + 1_000));

    expect(isHandoffStale(handoff, next.events)).toBe(true);
    expect(next.snapshots[0].alerts.some((alert) => alert.title === "Fictional new task")).toBe(true);
  });

  it("clears the stale state when an explicit refresh returns a candidate covering the new source cutoff", async () => {
    const unit = createDemoUnit();
    const patient = unit.patients[0];
    const events = unit.chartEvents.filter((event) => event.patientId === patient.id);
    const original = await new HandoffPipeline().generate(patient, events, unit.now);
    const newerEvent = { ...events[0], recordedAt: new Date(unit.now.getTime() + 1_000).toISOString() };
    const stale = createLiveBoardState({ patients: [patient], events: [...events, newerEvent], handoffs: [original], now: unit.now });
    const candidate = { ...original, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1", versionNumber: 2, status: "candidate" as const, sourceEventCutoff: newerEvent.recordedAt };

    const refreshed = applyCandidateVersion(stale, candidate);

    expect(isHandoffStale(refreshed.handoffs[0], refreshed.events)).toBe(false);
    expect(refreshed.handoffs[0].status).toBe("candidate");
  });
});
