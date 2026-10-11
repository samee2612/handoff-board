import { describe, expect, it } from "vitest";
import type { ChartEvent } from "@/lib/contracts";
import { makeChartEvents, makeGraph } from "./fixtures";
import { runToReview } from "./helpers";

const DAY = "2026-10-11";
const at = (hour: number, minute = 0) =>
  `${DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

describe("graph deterministic trend and plausibility integration", () => {
  it("adds deterministic trend facts and separate data-quality, attention, and overdue flags", async () => {
    const patientId = "pt-4";
    const readings: ChartEvent[] = [122, 110, 98, 88].map((systolic, index) => ({
      id: `evt-${901 + index}`,
      patientId,
      category: "vital",
      occurredAt: at([9, 11, 13, 16][index]),
      recordedAt: at([9, 11, 13, 16][index]),
      sourceLabel: "Synthetic trend fixture",
      payload: {
        systolicBloodPressure: systolic,
        diastolicBloodPressure: [78, 70, 60, 54][index],
      },
    }));
    const events: ChartEvent[] = [
      ...readings,
      {
        id: "evt-910",
        patientId,
        category: "nursing_note",
        occurredAt: at(16, 55),
        recordedAt: at(16, 55),
        sourceLabel: "Synthetic note fixture",
        payload: { summary: "BP 1O4/6O" },
      },
      {
        id: "evt-911",
        patientId,
        category: "task",
        occurredAt: at(11),
        recordedAt: at(11),
        sourceLabel: "Synthetic task fixture",
        payload: { title: "Recheck BP", dueAt: at(12), status: "open" },
      },
      ...makeChartEvents(patientId)
        .filter((event) => event.category === "medication")
        .map((event, index) => ({ ...event, id: `evt-${930 + index}` })),
    ];
    const { graph, input, llm } = makeGraph({ events });
    input.generatedAt = at(17);
    const state = await runToReview(graph, input);
    const synthesisInput = llm.callsFor("synthesize_sbar")[0].input as {
      facts: Array<{ summary: string; evidenceEventIds: string[] }>;
    };

    expect(state.attention).toBe("urgent");
    expect(state.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        summary: expect.stringContaining("decreased from 122 to 88"),
        evidenceEventIds: ["evt-901", "evt-902", "evt-903", "evt-904"],
      }),
    ]));
    expect(synthesisInput.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("decreased from 122 to 88") }),
    ]));
    expect(synthesisInput).not.toHaveProperty("flags");
    expect(state.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "urgent_attention", evidenceEventIds: ["evt-904"] }),
      expect.objectContaining({ kind: "data_quality", evidenceEventIds: ["evt-910"] }),
      expect.objectContaining({ kind: "overdue_task", evidenceEventIds: ["evt-911"] }),
    ]));
  }, 10_000);
});
