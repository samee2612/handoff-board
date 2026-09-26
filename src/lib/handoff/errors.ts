export class HandoffPipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HandoffPipelineError";
  }
}

export function toPipelineError(error: unknown, fallbackCode: string): HandoffPipelineError {
  if (error instanceof HandoffPipelineError) return error;
  return new HandoffPipelineError(fallbackCode, error instanceof Error ? error.message : "Unknown agent failure");
}
