import { describe, expect, it } from "vitest";
import { collectUpdates, runToReview } from "./helpers";
import { makeGraph } from "./fixtures";

describe("LangGraph happy path", () => {
  it("runs load -> engine -> specialists -> synthesize -> verify -> assemble and pauses at human_review", async () => {
    const { graph, input } = makeGraph();
    const updates = await collectUpdates(graph, input);
    const nodeOrder = updates.map(({ node }) => node).filter((node) => node !== "__interrupt__");
    const state = await graph.getState({ configurable: { thread_id: input.runId } });

    expect(nodeOrder).toEqual([
      "load_context",
      "deterministic_engine",
      "retrieve_protocols",
      "chart_vitals",
      "medications",
      "tasks_incidents",
      "join_facts",
      "synthesize_sbar",
      "verify_evidence",
      "assemble_candidate",
    ]);
    expect(state.values.status).toBe("awaiting_review");
    expect(state.values.versionId).toBeTruthy();
  }, 10_000);

  it("computes attention and nextDueAt from code: BP 88 is urgent and due at 17:00", async () => {
    const { graph, input, llm } = makeGraph();
    llm.queue("synthesize_sbar", {
      claims: [{
        section: "assessment",
        text: "routine",
        evidenceEventIds: ["evt-901"],
      }],
    });
    const state = await runToReview(graph, input);
    const synthesisInput = llm.callsFor("synthesize_sbar")[0].input as Record<string, unknown>;

    expect(state.attention).toBe("urgent");
    expect(state.nextDueAt?.slice(11, 16)).toBe("17:00");
    expect(synthesisInput).not.toHaveProperty("attention");
    expect(synthesisInput).not.toHaveProperty("nextDueAt");
  }, 10_000);

  it("appends facts from all three specialists instead of overwriting them", async () => {
    const { graph, input } = makeGraph();
    const state = await runToReview(graph, input);

    expect(state.facts).toHaveLength(5);
    expect(new Set(state.facts.map((fact) => fact.specialist))).toEqual(
      new Set(["chart_vitals", "medications", "tasks_incidents"]),
    );
  }, 10_000);

  it("each specialist only receives its own event categories", async () => {
    const { graph, input, llm } = makeGraph();
    await runToReview(graph, input);

    const categoriesFor = (node: "chart_vitals" | "medications" | "tasks_incidents") => {
      const call = llm.callsFor(node)[0];
      return (call.input as { events: Array<{ category: string }> }).events.map((event) => event.category);
    };

    expect(new Set(categoriesFor("chart_vitals"))).toEqual(new Set(["vital", "nursing_note"]));
    expect(new Set(categoriesFor("medications"))).toEqual(new Set(["medication"]));
    expect(categoriesFor("tasks_incidents")).toContain("task");
    expect(categoriesFor("tasks_incidents").every((category) => ["task", "incident"].includes(category))).toBe(true);
  }, 10_000);
});
