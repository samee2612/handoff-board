import type { StructuredGenerationRequest, StructuredOutputClient } from "@/lib/handoff/structured-output";

export type LlmNode =
  | "chart_vitals"
  | "medications"
  | "tasks_incidents"
  | "synthesize_sbar"
  | "verify_evidence";

export type LlmCall = {
  nodeName: LlmNode;
  input: unknown;
  timestamp: string;
};

type ScriptedResponse =
  | unknown
  | Error
  | ((input: unknown) => unknown);

const nodeForSchema: Record<string, LlmNode> = {
  chart_vitals_facts: "chart_vitals",
  medications_facts: "medications",
  tasks_incidents_facts: "tasks_incidents",
  sbar_handoff: "synthesize_sbar",
  evidence_verification: "verify_evidence",
};

export class ScriptedLlm implements StructuredOutputClient {
  readonly model = "scripted-fixture";
  readonly calls: LlmCall[] = [];
  private readonly responses = new Map<LlmNode, ScriptedResponse[]>();

  constructor(
    private readonly fallback: (nodeName: LlmNode, input: unknown) => unknown,
    private readonly clock: () => Date = () => new Date("2026-10-11T16:00:00.000Z"),
  ) {}

  queue(nodeName: LlmNode, ...responses: ScriptedResponse[]): void {
    const queued = this.responses.get(nodeName) ?? [];
    queued.push(...responses);
    this.responses.set(nodeName, queued);
  }

  callsFor(nodeName: LlmNode): LlmCall[] {
    return this.calls.filter((call) => call.nodeName === nodeName);
  }

  async generate<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const nodeName = nodeForSchema[request.schemaName];
    if (!nodeName) throw new Error(`No fake-LLM node mapping for schema '${request.schemaName}'.`);

    this.calls.push({
      nodeName,
      input: structuredClone(request.input),
      timestamp: this.clock().toISOString(),
    });

    const queue = this.responses.get(nodeName);
    const next = queue?.shift();
    const response = next === undefined ? this.fallback(nodeName, request.input) : next;
    if (response instanceof Error) throw response;
    const parsedResponse = typeof response === "function"
      ? response(request.input)
      : response;
    const decodedResponse = typeof parsedResponse === "string"
      ? JSON.parse(parsedResponse) as unknown
      : parsedResponse;
    return request.schema.parse(decodedResponse);
  }
}
