import { describe, expect, it } from "vitest";
import { makeGraph } from "./fixtures";
import { runToReview } from "./helpers";

function claimResponse(text: string, evidenceEventIds: string[]) {
  return {
    claims: [{
      section: "assessment",
      text,
      evidenceEventIds,
    }],
  };
}

function supportedResponse(input: unknown) {
  return {
    decisions: (input as { claims: Array<{ id: string }> }).claims.map((claim) => ({
      claimId: claim.id,
      status: "supported",
      reason: "The scripted verifier says supported.",
    })),
  };
}

describe("deterministic evidence code checks", () => {
  it("rejects a claim that cites an event ID not present in the facts", async () => {
    const { graph, input, llm } = makeGraph({ maxRetries: 0 });
    llm.queue("synthesize_sbar", claimResponse("A claim with unsupported evidence", ["evt-999"]));
    llm.queue("verify_evidence", supportedResponse);
    const state = await runToReview(graph, input);

    expect(state.decisions).toEqual([
      expect.objectContaining({ status: "gap", reason: expect.stringMatching(/absent|outside/i) }),
    ]);
  }, 10_000);

  it("rejects a claim whose number does not appear in the cited event", async () => {
    const { graph, input, llm } = makeGraph({ maxRetries: 0 });
    llm.queue("synthesize_sbar", claimResponse("Systolic BP 90 at 16:00", ["evt-901"]));
    llm.queue("verify_evidence", supportedResponse);
    const state = await runToReview(graph, input);

    expect(state.decisions).toEqual([
      expect.objectContaining({ status: "gap", reason: expect.stringMatching(/number|payload/i) }),
    ]);
  }, 10_000);

  it("accepts a claim whose numbers and IDs match the cited event", async () => {
    const { graph, input, llm } = makeGraph({ maxRetries: 0 });
    llm.queue("synthesize_sbar", claimResponse("Systolic BP 88 at 16:00", ["evt-901"]));
    const state = await runToReview(graph, input);

    expect(state.decisions).toEqual([
      expect.objectContaining({ status: "supported" }),
    ]);
    expect(state.failure).toBeNull();
  }, 10_000);

  it("verifier cannot override a code failure", async () => {
    const { graph, input, llm } = makeGraph({ maxRetries: 0 });
    llm.queue("synthesize_sbar", claimResponse("A claim with unsupported evidence", ["evt-999"]));
    llm.queue("verify_evidence", supportedResponse);
    const state = await runToReview(graph, input);

    expect(state.decisions).toEqual([
      expect.objectContaining({ status: "gap", reason: expect.stringMatching(/code|absent|outside/i) }),
    ]);
    expect(state.supportedClaims).toHaveLength(0);
  }, 10_000);
});
