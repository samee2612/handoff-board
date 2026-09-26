import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVELOPMENT_MODEL,
  HIGH_CAPABILITY_EVALUATION_MODEL,
  getConfiguredModel,
} from "@/lib/config/model";

describe("getConfiguredModel", () => {
  it("uses the lower-cost model unless an environment override is supplied", () => {
    expect(getConfiguredModel({})).toBe(DEFAULT_DEVELOPMENT_MODEL);
    expect(getConfiguredModel({ OPENAI_MODEL: HIGH_CAPABILITY_EVALUATION_MODEL })).toBe(
      HIGH_CAPABILITY_EVALUATION_MODEL,
    );
  });
});
