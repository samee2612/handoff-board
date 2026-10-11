import { GoogleGenAI } from "@google/genai";

export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export const PROTOCOL_EMBEDDING_DIMENSIONS = 768;

export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface ProtocolEmbeddingProvider {
  embed(text: string, taskType: EmbeddingTaskType): Promise<number[]>;
}

/** Generates fixed-size vectors for protocol chunks and retrieval queries. */
export class GeminiProtocolEmbedder implements ProtocolEmbeddingProvider {
  private client: GoogleGenAI | null = null;

  async embed(text: string, taskType: EmbeddingTaskType): Promise<number[]> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY is required for live protocol embeddings.");
    if (!text.trim()) throw new Error("Protocol embedding input must not be empty.");
    this.client ??= new GoogleGenAI({ apiKey });

    const response = await this.client.models.embedContent({
      model: GEMINI_EMBEDDING_MODEL,
      contents: text,
      config: {
        taskType,
        outputDimensionality: PROTOCOL_EMBEDDING_DIMENSIONS,
      },
    });
    const values = response.embeddings?.[0]?.values;
    if (
      !values ||
      values.length !== PROTOCOL_EMBEDDING_DIMENSIONS ||
      values.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Gemini returned an invalid protocol embedding vector.");
    }
    return values;
  }
}
