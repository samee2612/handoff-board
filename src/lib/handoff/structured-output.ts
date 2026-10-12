import "server-only";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { getConfiguredModel, getGeminiModel } from "@/lib/config/model";
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

/** Gemini structured output client using @google/genai with JSON schema constraints. */
export class GeminiStructuredOutputClient implements StructuredOutputClient {
  readonly model: string;
  private readonly client: GoogleGenAI;

  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new HandoffPipelineError("MISSING_API_KEY", "GEMINI_API_KEY or GOOGLE_API_KEY is required for the Gemini adapter");
    }
    this.model = options?.model ?? getGeminiModel();
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    try {
      let responseSchema: Record<string, unknown> | undefined;
      try {
        const rawSchema = (z as unknown as { toJSONSchema?: (s: z.ZodType<unknown>) => Record<string, unknown> }).toJSONSchema
          ? (z as unknown as { toJSONSchema: (s: z.ZodType<unknown>) => Record<string, unknown> }).toJSONSchema(request.schema)
          : undefined;
        if (rawSchema && typeof rawSchema === "object") {
          responseSchema = { ...rawSchema };
          delete responseSchema["$schema"];
        }
      } catch {
        responseSchema = undefined;
      }

      const prompt = [
        `Instructions: ${request.instructions}`,
        "",
        "Input Data (JSON):",
        JSON.stringify(request.input, null, 2),
        "",
        "Respond ONLY with valid JSON conforming to the requested schema. Do not add markdown explanation or extra text outside JSON.",
      ].join("\n");

      let response;
      try {
        response = await this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            ...(responseSchema ? { responseSchema } : {}),
          },
        });
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded")) {
          console.warn(`[Gemini] Primary model ${this.model} quota exceeded; retrying with gemini-3.5-flash-lite...`);
          response = await this.client.models.generateContent({
            model: "gemini-3.5-flash-lite",
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              ...(responseSchema ? { responseSchema } : {}),
            },
          });
        } else {
          throw firstErr;
        }
      }

      const text = response.text?.trim();
      if (!text) {
        throw new HandoffPipelineError("EMPTY_MODEL_OUTPUT", "The Gemini model returned no structured output");
      }

      let cleaned = text;
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      }

      const parsedJson = JSON.parse(cleaned);
      return request.schema.parse(parsedJson);
    } catch (error) {
      if (error instanceof HandoffPipelineError) throw error;
      throw new HandoffPipelineError(
        "STRUCTURED_OUTPUT_FAILURE",
        error instanceof Error ? error.message : "The Gemini structured output request failed",
      );
    }
  }
}

/** Server-only OpenAI adapter. It is never imported by browser components and always disables response storage. */
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

/** Returns the active configured StructuredOutputClient (Gemini prioritized, then OpenAI, or undefined). */
export function createConfiguredStructuredOutputClient(): StructuredOutputClient | undefined {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      return new GeminiStructuredOutputClient({ apiKey: geminiKey });
    } catch (error) {
      console.warn("Failed to initialize Gemini structured client:", error);
    }
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      return new OpenAiStructuredOutputClient({ apiKey: openaiKey });
    } catch (error) {
      console.warn("Failed to initialize OpenAI structured client:", error);
    }
  }
  return undefined;
}
