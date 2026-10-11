import "server-only";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { OpenAiStructuredOutputClient } from "@/lib/handoff/structured-output";
import type { HandoffDataLayer } from "@/lib/handoff/data-layer";

/** Creates the explicit server-side live-model variant; fixture tests keep using the fixture graph. */
export function createOpenAiHandoffPipeline(options?: {
  apiKey?: string;
  model?: string;
  data?: HandoffDataLayer;
  checkpointer?: BaseCheckpointSaver;
}): HandoffPipeline {
  return new HandoffPipeline({
    client: new OpenAiStructuredOutputClient({ apiKey: options?.apiKey, model: options?.model }),
    data: options?.data,
    checkpointer: options?.checkpointer,
  });
}
