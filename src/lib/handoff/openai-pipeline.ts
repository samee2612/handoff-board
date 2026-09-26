import "server-only";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { OpenAiStructuredOutputClient } from "@/lib/handoff/structured-output";
import type { HandoffVersionStore } from "@/lib/handoff/version-store";

/** Creates the explicit server-side live-model variant; fixture tests keep using HandoffPipeline(). */
export function createOpenAiHandoffPipeline(options?: {
  apiKey?: string;
  model?: string;
  store?: HandoffVersionStore;
}): HandoffPipeline {
  return new HandoffPipeline({
    client: new OpenAiStructuredOutputClient({ apiKey: options?.apiKey, model: options?.model }),
    store: options?.store,
  });
}
