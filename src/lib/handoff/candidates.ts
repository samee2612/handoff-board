import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HandoffVersion } from "@/lib/contracts";
import { handoffVersionSchema } from "@/lib/contracts";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { loadSyntheticPatientAndEvents } from "@/lib/supabase/board-data";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

export const candidateRefreshRequestSchema = z.object({ patientId: z.string().uuid() }).strict();

export class CandidateRefreshError extends Error {
  constructor(readonly code: "NOT_FOUND" | "SETUP_REQUIRED" | "PERSISTENCE_FAILED", message: string) {
    super(message);
  }
}

function refreshPipeline(): HandoffPipeline {
  // This demo endpoint is intentionally unauthenticated. Keep refreshes deterministic and cost-free
  // until a later authenticated server-side authorization design can safely gate live model usage.
  return new HandoffPipeline();
}

function toCandidate(version: HandoffVersion): HandoffVersion {
  return version.status === "published" ? { ...version, status: "candidate" } : version;
}

async function persistCandidate(version: HandoffVersion): Promise<HandoffVersion> {
  const client = createOptionalSupabaseServiceClient();
  if (!client) throw new CandidateRefreshError("SETUP_REQUIRED", "Supabase persistence is not configured for this demo.");
  const { data, error } = await client.rpc("append_handoff_version", {
    p_id: version.id,
    p_patient_id: version.patientId,
    p_source_event_cutoff: version.sourceEventCutoff,
    p_status: version.status,
    p_model: version.model,
    p_generated_at: version.generatedAt,
    p_content: version,
    p_evidence_gap_count: version.excludedClaims.length,
    p_failure_code: version.failure?.code ?? null,
    p_failure_message: version.failure?.message ?? null,
  }).single();
  if (error || !data) throw new CandidateRefreshError("PERSISTENCE_FAILED", "The candidate version could not be saved.");
  const result = data as { version_id: string; version_number: number };
  return handoffVersionSchema.parse({ ...version, id: result.version_id, versionNumber: result.version_number });
}

/** Explicit-only generation. A Realtime event never calls this function automatically. */
export async function createCandidateVersion(patientId: string): Promise<HandoffVersion> {
  const stored = await loadSyntheticPatientAndEvents(patientId);
  if (stored) return persistCandidate(toCandidate(await refreshPipeline().generate(stored.patient, stored.events, new Date())));

  if (createOptionalSupabaseServiceClient()) throw new CandidateRefreshError("NOT_FOUND", "The requested synthetic patient was not found.");
  const demo = createDemoUnit();
  const patient = demo.patients.find((item) => item.id === patientId);
  if (!patient) throw new CandidateRefreshError("NOT_FOUND", "The requested synthetic patient was not found.");
  const pipeline = refreshPipeline();
  for (const item of demo.patients) {
    await pipeline.generate(item, demo.chartEvents.filter((event) => event.patientId === item.id), demo.now);
  }
  const candidate = toCandidate(await pipeline.generate(patient, demo.chartEvents.filter((event) => event.patientId === patient.id), demo.now));
  return { ...candidate, id: randomUUID() };
}
