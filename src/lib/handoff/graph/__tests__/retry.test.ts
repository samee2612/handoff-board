import { describe, expect, it } from "vitest";
import { makeGraph } from "./fixtures";
import { runToReview } from "./helpers";

function claimResponse(text: string, evidenceEventIds = ["evt-901"]) {
  return {
    claims: [{
      section: "assessment",
      text,
      evidenceEventIds,
    }],
  };
}

function gapResponse(input: unknown) {
  const claims = (input as { claims: Array<{ id: string }> }).claims;
  return {
    decisions: claims.map((claim) => ({
      claimId: claim.id,
      status: "gap",
      reason: "The claim is not supported by its cited facts.",
    })),
  };
}

describe("synthesis retry routing", () => {
  it("retries once when the first draft has a gap and succeeds on the second", async () => {
    const { graph, input, llm } = makeGraph();
    llm.queue(
      "synthesize_sbar",
      claimResponse("Give IV fluids now."),
      claimResponse("Systolic BP 88", ["evt-901"]),
    );
    llm.queue("verify_evidence", gapResponse);

    const state = await runToReview(graph, input);
    const retryInput = llm.callsFor("synthesize_sbar")[1].input as {
      deterministicContext: { gapFeedback: string[] };
    };

    expect(llm.callsFor("synthesize_sbar")).toHaveLength(2);
    expect(state.retryCount).toBe(1);
    expect(retryInput.deterministicContext.gapFeedback).toEqual(
      expect.arrayContaining([expect.stringContaining("not supported")]),
    );
    expect(state.status).toBe("awaiting_review");
  }, 10_000);

  it("fails closed when every attempt has a gap", async () => {
    const { graph, input, llm, data, patient } = makeGraph();
    llm.queue("synthesize_sbar", claimResponse("Give IV fluids now."), claimResponse("Give IV fluids now."));
    llm.queue("verify_evidence", gapResponse, gapResponse);

    const state = await runToReview(graph, input);
    const versions = await data.list(patient.id);

    expect(state.status).toBe("failed");
    expect(state.failure?.code).toBe("NO_SUPPORTED_CLAIMS");
    expect(versions.every((version) => version.status !== "candidate")).toBe(true);
    expect(llm.callsFor("synthesize_sbar")).toHaveLength(state.maxRetries + 1);
  }, 10_000);

  it("does not retry when all claims are supported on the first attempt", async () => {
    const { graph, input, llm } = makeGraph();
    const state = await runToReview(graph, input);

    expect(llm.callsFor("synthesize_sbar")).toHaveLength(1);
    expect(state.retryCount).toBe(0);
    expect(state.status).toBe("awaiting_review");
  }, 10_000);
});
