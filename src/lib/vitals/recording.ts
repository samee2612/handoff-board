import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChartEvent, VitalType } from "@/lib/contracts";
import { vitalTypeSchema } from "@/lib/contracts";
import { persistCandidateVersion, CandidateRefreshError } from "@/lib/handoff/candidates";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";
import { loadSyntheticPatientAndEvents, loadSyntheticVitalMonitoringPlans } from "@/lib/supabase/board-data";
import { createVitalHandoffCandidate } from "@/lib/vitals/handoff";
import { extractVitalFromNote } from "@/lib/vitals/note-agent";
import { createDemoUnit } from "@/lib/demo/seed-data";

const valueSchema = z.number().finite().positive();

export const vitalRecordingRequestSchema = z
  .object({
    patientId: z.string().uuid(),
    vitalType: vitalTypeSchema,
    value: valueSchema,
    diastolicValue: valueSchema.optional(),
    recordedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.vitalType === "blood_pressure" && value.diastolicValue === undefined) {
      context.addIssue({ code: "custom", path: ["diastolicValue"], message: "A diastolic value is required for blood pressure." });
    }
    if (value.vitalType !== "blood_pressure" && value.diastolicValue !== undefined) {
      context.addIssue({ code: "custom", path: ["diastolicValue"], message: "A diastolic value is only valid for blood pressure." });
    }
  });

export type VitalRecordingInput = z.infer<typeof vitalRecordingRequestSchema>;
export const vitalCommentRequestSchema = z.object({ patientId: z.string().uuid(), note: z.string().trim().min(3).max(500) }).strict();

export class VitalRecordingError extends Error {
  constructor(readonly code: "NOT_FOUND" | "SETUP_REQUIRED" | "PLAN_REQUIRED" | "PERSISTENCE_FAILED", message: string) {
    super(message);
  }
}

function payloadFor(vitalType: VitalType, value: number, diastolicValue?: number) {
  switch (vitalType) {
    case "blood_pressure": return { systolicBloodPressure: value, diastolicBloodPressure: diastolicValue! };
    case "heart_rate": return { heartRate: value };
    case "temperature": return { temperatureCelsius: value };
    case "oxygen_saturation": return { oxygenSaturation: value };
    case "blood_glucose": return { bloodGlucose: value };
  }
}

export async function recordSyntheticVital(input: VitalRecordingInput) {
  const client = createOptionalSupabaseServiceClient();
  const remote = await loadSyntheticPatientAndEvents(input.patientId);
  const fixture = createDemoUnit();
  const stored = remote ?? (() => {
    const patient = fixture.patients.find((item) => item.id === input.patientId);
    return patient ? { patient, events: fixture.chartEvents.filter((event) => event.patientId === patient.id) } : null;
  })();
  if (!stored) throw new VitalRecordingError("NOT_FOUND", "The requested synthetic patient was not found.");
  const plans = remote ? await loadSyntheticVitalMonitoringPlans(input.patientId) : fixture.vitalMonitoringPlans.filter((plan) => plan.patientId === input.patientId);
  if (!plans.some((plan) => plan.vitalType === input.vitalType)) {
    throw new VitalRecordingError("PLAN_REQUIRED", "This patient has no synthetic monitoring plan for that vital.");
  }

  const now = input.recordedAt ? new Date(input.recordedAt) : new Date();
  const event: Extract<ChartEvent, { category: "vital" }> = {
    id: randomUUID(),
    patientId: input.patientId,
    category: "vital",
    occurredAt: now.toISOString(),
    recordedAt: now.toISOString(),
    sourceLabel: "Fictional vital-sign record",
    payload: payloadFor(input.vitalType, input.value, input.diastolicValue),
  };
  if (client) {
    const { error } = await client.from("patient_chart_events").insert({
      id: event.id,
      patient_id: event.patientId,
      category: event.category,
      occurred_at: event.occurredAt,
      recorded_at: event.recordedAt,
      source_label: event.sourceLabel,
      payload: event.payload,
    });
    if (error) throw new VitalRecordingError("PERSISTENCE_FAILED", "The synthetic vital could not be saved.");
  }

  try {
    const generated = await createVitalHandoffCandidate({
      patient: stored.patient,
      events: [...stored.events, event],
      plans,
      recordedVital: event,
      generatedAt: now,
    });
    return { event, monitoring: generated.monitoring, candidate: client ? await persistCandidateVersion(generated.candidate) : generated.candidate };
  } catch (error) {
    if (error instanceof CandidateRefreshError) throw new VitalRecordingError("PERSISTENCE_FAILED", error.message);
    throw error;
  }
}

export async function recordSyntheticVitalComment(patientId: string, note: string) {
  const parsed = extractVitalFromNote(note);
  return recordSyntheticVital({ patientId, ...parsed });
}
