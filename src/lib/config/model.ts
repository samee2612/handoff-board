/**
 * The handoff pipeline is not introduced until step 2. Keeping this choice here prevents
 * development and tests from accidentally defaulting to the highest-capability model.
 */
export const DEFAULT_DEVELOPMENT_MODEL = "gpt-5-mini";
export const HIGH_CAPABILITY_EVALUATION_MODEL = "gpt-6-astra";

export type ModelEnvironment = { OPENAI_MODEL?: string };

export function getConfiguredModel(
  environment: ModelEnvironment = { OPENAI_MODEL: process.env.OPENAI_MODEL },
): string {
  return environment.OPENAI_MODEL || DEFAULT_DEVELOPMENT_MODEL;
}
