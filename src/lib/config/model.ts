/**
 * The handoff pipeline is not introduced until step 2. Keeping this choice here prevents
 * development and tests from accidentally defaulting to the highest-capability model.
 */
export const DEFAULT_DEVELOPMENT_MODEL = "gpt-5-mini";
export const HIGH_CAPABILITY_EVALUATION_MODEL = "gpt-6-astra";
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

export type ModelEnvironment = { OPENAI_MODEL?: string; GEMINI_MODEL?: string };

export function getConfiguredModel(
  environment: ModelEnvironment = { OPENAI_MODEL: process.env.OPENAI_MODEL },
): string {
  return environment.OPENAI_MODEL || DEFAULT_DEVELOPMENT_MODEL;
}

export function getGeminiModel(
  environment: ModelEnvironment = { GEMINI_MODEL: process.env.GEMINI_MODEL },
): string {
  return environment.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}
