import { Command } from "@langchain/langgraph";
import type { HandoffGraphState } from "@/lib/handoff/pipeline";
import type { GraphTestInput } from "./fixtures";
import type { buildHandoffGraph } from "@/lib/handoff/pipeline";

export type TestGraph = ReturnType<typeof buildHandoffGraph>;

export type NodeUpdate = {
  node: string;
  update: unknown;
};

export async function runToReview(
  graph: TestGraph,
  input: GraphTestInput,
): Promise<HandoffGraphState> {
  return graph.invoke(input, {
    configurable: { thread_id: input.runId },
  });
}

export async function resume(
  graph: TestGraph,
  threadId: string,
  decision: string,
): Promise<HandoffGraphState> {
  return graph.invoke(new Command({ resume: decision }), {
    configurable: { thread_id: threadId },
  });
}

export async function collectUpdates(
  graph: TestGraph,
  input: GraphTestInput,
): Promise<NodeUpdate[]> {
  const updates: NodeUpdate[] = [];
  const stream = await graph.stream(input, {
    configurable: { thread_id: input.runId },
    streamMode: "updates",
  });

  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk)) {
      updates.push({ node, update });
    }
  }

  return updates;
}
