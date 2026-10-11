import "server-only";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export interface HandoffCheckpointerProvider {
  get(): Promise<BaseCheckpointSaver>;
}

/** Creates and initializes the durable LangGraph checkpoint store for server runs. */
export class PostgresHandoffCheckpointer implements HandoffCheckpointerProvider {
  private saverPromise: Promise<PostgresSaver> | null = null;

  async get(): Promise<BaseCheckpointSaver> {
    const connectionString = process.env.SUPABASE_DB_URL;
    if (!connectionString) {
      throw new Error("SUPABASE_DB_URL is required for persistent handoff review.");
    }
    if (!this.saverPromise) {
      this.saverPromise = this.initialize(connectionString).catch((error: unknown) => {
        this.saverPromise = null;
        throw error;
      });
    }
    return this.saverPromise;
  }

  private async initialize(connectionString: string): Promise<PostgresSaver> {
    const saver = PostgresSaver.fromConnString(connectionString);
    await saver.setup();
    return saver;
  }
}

const serverCheckpointer = new PostgresHandoffCheckpointer();

export function getHandoffCheckpointer(): Promise<BaseCheckpointSaver> {
  return serverCheckpointer.get();
}
