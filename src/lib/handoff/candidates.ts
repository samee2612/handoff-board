import "server-only";
import { z } from "zod";
import type { HandoffVersion } from "@/lib/contracts";
import { createDemoUnit } from "@/lib/demo/seed-data";
import {
  ChartVitalsSpecialist,
  EvidenceVerifier,
  MedicationSpecialist,
  SbarSynthesizer,
  TasksIncidentsSpecialist,
} from "@/lib/handoff/agents";
import { getHandoffCheckpointer } from "@/lib/handoff/checkpointer";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { createConfiguredStructuredOutputClient } from "@/lib/handoff/structured-output";
import { SupabaseHandoffDataLayer } from "@/lib/handoff/supabase-data-layer";
import { loadSyntheticPatientAndEvents } from "@/lib/supabase/board-data";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

export const candidateRefreshRequestSchema = z.object({ patientId: z.string().uuid() }).strict();

export class CandidateRefreshError extends Error {
  constructor(readonly code: "NOT_FOUND" | "SETUP_REQUIRED" | "PERSISTENCE_FAILED", message: string) {
    super(message);
  }
}

export function createConfiguredPipeline(dataLayer?: SupabaseHandoffDataLayer, checkpointer?: any): HandoffPipeline {
  const client = createConfiguredStructuredOutputClient();
  if (!client) {
    return new HandoffPipeline({
      data: dataLayer,
      checkpointer,
    });
  }

  return new HandoffPipeline({
    data: dataLayer,
    checkpointer,
    agents: {
      specialists: {
        chart_vitals: new ChartVitalsSpecialist(),
        medications: new MedicationSpecialist(),
        tasks_incidents: new TasksIncidentsSpecialist(),
      },
      synthesizer: new SbarSynthesizer(client),
      verifier: new EvidenceVerifier(),
    },
  });
}

/** Explicit-only generation. A Realtime event never calls this function automatically. */
export async function createCandidateVersion(patientId: string): Promise<HandoffVersion> {
  const client = createOptionalSupabaseServiceClient();
  let stored: { patient: any; events: any[] } | null = null;
  if (client) {
    try {
      stored = await loadSyntheticPatientAndEvents(patientId);
    } catch {
      stored = null;
    }
  }

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
    try {
      const pipeline = createConfiguredPipeline(new SupabaseHandoffDataLayer(client), checkpointer);
      const result = await pipeline.generate(stored.patient, stored.events, new Date());
      if (result.status === "failed") {
        console.warn("AI generation returned status 'failed', falling back to deterministic pipeline:", result.failure?.message);
        const fallbackPipeline = new HandoffPipeline({
          data: new SupabaseHandoffDataLayer(client),
          checkpointer,
        });
        return await fallbackPipeline.generate(stored.patient, stored.events, new Date());
      }
      return result;
    } catch (aiError) {
      console.warn("AI generation failed, falling back to deterministic pipeline:", aiError);
      const fallbackPipeline = new HandoffPipeline({
        data: new SupabaseHandoffDataLayer(client),
        checkpointer,
      });
      return await fallbackPipeline.generate(stored.patient, stored.events, new Date());
    }
  }

  const demo = createDemoUnit(undefined, true);
  const patient = demo.patients.find((item) => item.id === patientId);
  if (!patient) throw new CandidateRefreshError("NOT_FOUND", "The requested synthetic patient was not found.");

  const events = demo.chartEvents.filter((event) => event.patientId === patient.id);

  try {
    const pipeline = createConfiguredPipeline();
    console.log(`\n🤖 [Shift Handoff Agent] Starting SBAR synthesis for "${patient.displayName}"...`);
    const start = Date.now();
    const result = await pipeline.generate(patient, events, demo.now);
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    if (result.status === "failed") {
      console.warn(`⚠️ [Shift Handoff Agent] Gemini returned status 'failed' (${result.failure?.message}). Falling back to deterministic fixture.`);
      return new HandoffPipeline().generate(patient, events, demo.now);
    }
    console.log(`✨ [Shift Handoff Agent] Generated ${result.claims.length} SBAR claims using model: [${result.model}] in ${duration}s!`);
    return result;
  } catch (aiError) {
    console.warn(`⚠️ [Shift Handoff Agent] Gemini API call failed (${aiError instanceof Error ? aiError.message : aiError}). Falling back to deterministic fixture.`);
    return new HandoffPipeline().generate(patient, events, demo.now);
  }
}
