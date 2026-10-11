import { describe, expect, it } from "vitest";
import { makeChartEvents, makeGraph, makePatient } from "./fixtures";
import { runToReview } from "./helpers";

describe("fail-closed paths", () => {
  it("a specialist throwing produces a failed version, not a partial one", async () => {
    const { graph, input, llm, data, patient } = makeGraph();
    llm.queue("medications", new Error("Synthetic medication model outage"));

    const state = await runToReview(graph, input);
    const versions = await data.list(patient.id);

    expect(state.status).toBe("failed");
    expect(state.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: "medications", status: "failed", errorCode: "AGENT_FAILURE" }),
      ]),
    );
    expect(llm.callsFor("synthesize_sbar")).toHaveLength(0);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ status: "failed", claims: [] });
  }, 10_000);

  it("malformed LLM JSON is treated as a problem, not a crash", async () => {
    const { graph, input, llm } = makeGraph();
    llm.queue(
      "synthesize_sbar",
      "{ malformed JSON",
      {
        claims: [{
          section: "assessment",
          text: "Systolic BP 88",
          evidenceEventIds: ["evt-901"],
        }],
      },
    );

    const state = await runToReview(graph, input);

    expect(llm.callsFor("synthesize_sbar")).toHaveLength(2);
    expect(state.retryCount).toBe(1);
    expect(state.status).toBe("awaiting_review");
  }, 10_000);

  it("a non-synthetic patient is rejected before any LLM call", async () => {
    const patient = makePatient();
    Reflect.set(patient, "isSynthetic", false);
    const { graph, input, llm } = makeGraph({ patient, events: makeChartEvents(patient.id) });
    const state = await runToReview(graph, input);

    expect(state.status).toBe("rejected");
    expect(llm.calls).toHaveLength(0);
  }, 10_000);

  it("events for another patient are rejected", async () => {
    const events = makeChartEvents();
    events[0] = { ...events[0], patientId: "pt-9" };
    const { graph, input, llm } = makeGraph({ events });
    const state = await runToReview(graph, input);

    expect(state.status).toBe("failed");
    expect(state.failure?.code).toBe("MIXED_PATIENT_EVENTS");
    expect(llm.calls).toHaveLength(0);
  }, 10_000);
});
