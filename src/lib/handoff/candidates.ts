import "server-only";
import { z } from "zod";
import type { HandoffVersion } from "@/lib/contracts";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { getHandoffCheckpointer } from "@/lib/handoff/checkpointer";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { SupabaseHandoffDataLayer } from "@/lib/handoff/supabase-data-layer";
import { loadSyntheticPatientAndEvents } from "@/lib/supabase/board-data";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

export const candidateRefreshRequestSchema = z.object({ patientId: z.string().uuid() }).strict();

export class CandidateRefreshError extends Error {
  constructor(readonly code: "NOT_FOUND" | "SETUP_REQUIRED" | "PERSISTENCE_FAILED", message: string) {
    super(message);
  }
}

function refreshPipeline(): HandoffPipeline {
  // Keep fixture generation deterministic and cost-free when Supabase is not configured.
  return new HandoffPipeline();
}

/** Explicit-only generation. A Realtime event never calls this function automatically. */
export async function createCandidateVersion(patientId: string): Promise<HandoffVersion> {
  const stored = await loadSyntheticPatientAndEvents(patientId);
  const client = createOptionalSupabaseServiceClient();
  if (stored && client) {
    let checkpointer;
    try {
      checkpointer = await getHandoffCheckpointer();
    } catch (error) {
      throw new CandidateRefreshError(
        "SETUP_REQUIRED",
        error instanceof Error ? error.message : "Persistent graph checkpointing is not configured.",
      );
    }
    const pipeline = new HandoffPipeline({
      data: new SupabaseHandoffDataLayer(client),
      checkpointer,
    });
    return pipeline.generate(stored.patient, stored.events, new Date());
  }

  if (client) throw new CandidateRefreshError("NOT_FOUND", "The requested synthetic patient was not found.");
  const demo = createDemoUnit();
  const patient = demo.patients.find((item) => item.id === patientId);
  if (!patient) throw new CandidateRefreshError("NOT_FOUND", "The requested synthetic patient was not found.");
  return refreshPipeline().generate(
    patient,
    demo.chartEvents.filter((event) => event.patientId === patient.id),
    demo.now,
  );
}
