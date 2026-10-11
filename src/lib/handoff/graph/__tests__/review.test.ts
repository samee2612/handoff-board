import { describe, expect, it } from "vitest";
import { makeGraph } from "./fixtures";
import { resume, runToReview } from "./helpers";

describe("human review and publication", () => {
  it("does not publish without a resume", async () => {
    const { graph, input, data, patient } = makeGraph();
    const state = await runToReview(graph, input);

    expect(state.status).toBe("awaiting_review");
    expect(await data.listPublications(patient.id)).toHaveLength(0);
  }, 10_000);

  it("approved resume publishes exactly once", async () => {
    const { graph, input, data, patient } = makeGraph();
    const candidate = await runToReview(graph, input);
    const published = await resume(graph, input.runId, "approved");
    const publications = await data.listPublications(patient.id);

    expect(published.status).toBe("published");
    expect(publications).toHaveLength(1);
    expect(publications[0].handoffVersionId).toBe(candidate.versionId);
  }, 10_000);

  it("rejected resume ends without publishing", async () => {
    const { graph, input, data, patient } = makeGraph();
    await runToReview(graph, input);
    const rejected = await resume(graph, input.runId, "rejected");

    expect(rejected.status).toBe("rejected");
    expect(await data.listPublications(patient.id)).toHaveLength(0);
  }, 10_000);

  it("resume with an invalid decision is refused", async () => {
    const { graph, input, data, patient } = makeGraph();
    await runToReview(graph, input);

    await expect(resume(graph, input.runId, "maybe")).rejects.toThrow(/Review decision must be approved or rejected/);
    expect(await data.listPublications(patient.id)).toHaveLength(0);
  }, 10_000);

  it("versions are immutable: publishing does not edit the version", async () => {
    const { graph, input, data, patient } = makeGraph();
    const candidate = await runToReview(graph, input);
    const storedBefore = await data.get(candidate.versionId!);
    const serializedBefore = JSON.stringify(storedBefore);

    await resume(graph, input.runId, "approved");

    const storedAfter = await data.get(candidate.versionId!);
    expect(JSON.stringify(storedAfter)).toBe(serializedBefore);
    expect(storedAfter?.patientId).toBe(patient.id);
  }, 10_000);
});
