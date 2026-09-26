import "server-only";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { getConfiguredModel } from "@/lib/config/model";
import { HandoffPipelineError } from "@/lib/handoff/errors";

export type StructuredGenerationRequest<T> = {
  schema: z.ZodType<T>;
  schemaName: string;
  instructions: string;
  input: unknown;
};

export interface StructuredOutputClient {
  readonly model: string;
  generate<T>(request: StructuredGenerationRequest<T>): Promise<T>;
}

/** Server-only adapter. It is never imported by browser components and always disables response storage. */
export class OpenAiStructuredOutputClient implements StructuredOutputClient {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new HandoffPipelineError("MISSING_API_KEY", "OPENAI_API_KEY is required for the OpenAI adapter");
    this.model = options?.model ?? getConfiguredModel();
    this.client = new OpenAI({ apiKey });
  }

  async generate<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    try {
      const response = await this.client.responses.parse({
        model: this.model,
        instructions: request.instructions,
        input: JSON.stringify(request.input),
        store: false,
        text: { format: zodTextFormat(request.schema, request.schemaName) },
      });
      if (!response.output_parsed) {
        throw new HandoffPipelineError("EMPTY_MODEL_OUTPUT", "The model returned no structured output");
      }
      return request.schema.parse(response.output_parsed);
    } catch (error) {
      if (error instanceof HandoffPipelineError) throw error;
      throw new HandoffPipelineError(
        "STRUCTURED_OUTPUT_FAILURE",
        error instanceof Error ? error.message : "The structured output request failed",
      );
    }
  }
}
