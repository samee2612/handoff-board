import { describe, expect, it } from "vitest";
import { assertSyntheticOnlyDeployment, UnsafeDeploymentConfigurationError } from "@/lib/config/deployment";

describe("synthetic-only deployment guard", () => {
  it("permits local development and explicitly configured hosted demos", () => {
    expect(() => assertSyntheticOnlyDeployment({})).not.toThrow();
    expect(() => assertSyntheticOnlyDeployment({ VERCEL: "1", HANDOFF_BOARD_DATA_MODE: "synthetic-only" })).not.toThrow();
  });

  it("fails closed when a hosted deployment lacks the synthetic-only declaration", () => {
    expect(() => assertSyntheticOnlyDeployment({ VERCEL: "1" })).toThrow(UnsafeDeploymentConfigurationError);
    expect(() => assertSyntheticOnlyDeployment({ VERCEL: "1", HANDOFF_BOARD_DATA_MODE: "real-data" })).toThrow(
      "HANDOFF_BOARD_DATA_MODE=synthetic-only",
    );
  });
});
