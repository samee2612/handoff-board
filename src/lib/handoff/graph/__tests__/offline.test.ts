import { afterEach, describe, expect, it, vi } from "vitest";
import { makeGraph } from "./fixtures";
import { runToReview } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline fixture graph", () => {
  it("the graph runs with the network disabled", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("Network access is disabled in this test.");
    });
    const { graph, input, llm } = makeGraph();

    const state = await runToReview(graph, input);

    expect(state.status).toBe("awaiting_review");
    expect(llm.calls.length).toBeGreaterThan(0);
  }, 10_000);
});
