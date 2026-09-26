export const SYNTHETIC_ONLY_DEPLOYMENT_MODE = "synthetic-only";

export type DeploymentEnvironment = {
  VERCEL?: string;
  HANDOFF_BOARD_DATA_MODE?: string;
};

export class UnsafeDeploymentConfigurationError extends Error {}

/** Vercel deployments fail closed unless their managed environment explicitly opts into synthetic-only mode. */
export function assertSyntheticOnlyDeployment(
  environment: DeploymentEnvironment = {
    VERCEL: process.env.VERCEL,
    HANDOFF_BOARD_DATA_MODE: process.env.HANDOFF_BOARD_DATA_MODE,
  },
): void {
  if (environment.VERCEL === "1" && environment.HANDOFF_BOARD_DATA_MODE !== SYNTHETIC_ONLY_DEPLOYMENT_MODE) {
    throw new UnsafeDeploymentConfigurationError(
      "This hosted demo requires HANDOFF_BOARD_DATA_MODE=synthetic-only.",
    );
  }
}
