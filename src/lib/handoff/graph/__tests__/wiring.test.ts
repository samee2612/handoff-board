import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HandoffGraphState } from "@/lib/handoff/pipeline";
import { routeAfterVerify } from "@/lib/handoff/pipeline";
import { makeClaim, makeGraph } from "./fixtures";

const graphConfig = (threadId = randomUUID()) => ({
  configurable: { thread_id: threadId },
});

describe("compiled graph wiring", () => {
  it("every node is reachable from START", async () => {
    const { graph } = makeGraph();
    const compiled = await graph.getGraphAsync(graphConfig());
    const outgoing = new Map<string, string[]>();
    for (const edge of compiled.edges) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    }

    const visited = new Set<string>();
    const queue = ["__start__"];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      queue.push(...(outgoing.get(current) ?? []));
    }

    expect(Object.keys(compiled.nodes).filter((node) => !visited.has(node))).toEqual([]);
  }, 10_000);

  it("publish is reachable only through human_review", async () => {
    const { graph } = makeGraph();
    const compiled = await graph.getGraphAsync(graphConfig());
    const incoming = compiled.edges.filter((edge) => edge.target === "publish");

    expect(incoming.length).toBeGreaterThan(0);
    expect(incoming.every((edge) => edge.source === "human_review")).toBe(true);
  }, 10_000);

  it("route_after_verify has exactly three possible destinations", () => {
    const excluded = [{ claim: makeClaim({ text: "Gap", evidenceEventIds: ["evt-901"] }), reason: "Gap" }];
    const supported = [makeClaim({ text: "Supported", evidenceEventIds: ["evt-901"] })];
    const base: Pick<
      HandoffGraphState,
      "status" | "excludedClaims" | "retryCount" | "maxRetries" | "supportedClaims" | "gapFeedback"
    > = {
      status: "running",
      excludedClaims: excluded,
      retryCount: 0,
      maxRetries: 1,
      supportedClaims: [],
      gapFeedback: [],
    };
    const destinations = [
      routeAfterVerify(base),
      routeAfterVerify({ ...base, excludedClaims: [], supportedClaims: supported }),
      routeAfterVerify({ ...base, retryCount: 1, supportedClaims: [] }),
    ];

    expect(destinations).toEqual(["synthesize_sbar", "assemble_candidate", "failure_sink"]);
    expect(new Set(destinations).size).toBe(3);
  });

  it("route_after_verify is a pure function of state", () => {
    const state = {
      status: "running",
      excludedClaims: [{
        claim: makeClaim({ text: "Gap", evidenceEventIds: ["evt-901"] }),
        reason: "Unverified",
      }],
      retryCount: 0,
      maxRetries: 1,
      supportedClaims: [],
      gapFeedback: [],
    } satisfies Pick<
      HandoffGraphState,
      "status" | "excludedClaims" | "retryCount" | "maxRetries" | "supportedClaims" | "gapFeedback"
    >;
    const before = structuredClone(state);

    expect(routeAfterVerify(state)).toBe(routeAfterVerify(state));
    expect(state).toEqual(before);
  });
});
