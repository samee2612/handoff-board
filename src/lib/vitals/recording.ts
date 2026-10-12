import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChartEvent, VitalType } from "@/lib/contracts";
import { vitalTypeSchema } from "@/lib/contracts";
import { CandidateRefreshError, createCandidateVersion, createConfiguredPipeline } from "@/lib/handoff/candidates";
import { getHandoffCheckpointer } from "@/lib/handoff/checkpointer";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";
import { loadSyntheticPatientAndEvents, loadSyntheticVitalMonitoringPlans } from "@/lib/supabase/board-data";
import { createVitalHandoffCandidate } from "@/lib/vitals/handoff";
import { extractVitalFromNote } from "@/lib/vitals/note-agent";
import { parseClinicalNoteWithAI, createChartEventsFromParsedUpdate } from "@/lib/vitals/clinical-parser";
import { evaluateVitalMonitoring } from "@/lib/vitals/monitoring";
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
  let remote: { patient: any; events: any[] } | null = null;
  if (client) {
    try {
      remote = await loadSyntheticPatientAndEvents(input.patientId);
    } catch {
      remote = null;
    }
  }

  const fixture = createDemoUnit(undefined, true);
  const stored = remote ?? (() => {
    const patient = fixture.patients.find((item) => item.id === input.patientId);
    return patient ? { patient, events: fixture.chartEvents.filter((event) => event.patientId === patient.id) } : null;
  })();
  if (!stored) throw new VitalRecordingError("NOT_FOUND", "The requested synthetic patient was not found.");

  let plans = fixture.vitalMonitoringPlans.filter((plan) => plan.patientId === input.patientId);
  if (remote) {
    try {
      plans = await loadSyntheticVitalMonitoringPlans(input.patientId);
    } catch {
      // use fixture plans
    }
  }

  if (!plans.some((plan) => plan.vitalType === input.vitalType)) {
    throw new VitalRecordingError("PLAN_REQUIRED", "This patient has no synthetic monitoring plan for that vital.");
  }

  if (client && remote) {
    try {
      await getHandoffCheckpointer();
    } catch (error) {
      throw new VitalRecordingError(
        "SETUP_REQUIRED",
        error instanceof Error ? error.message : "Persistent graph checkpointing is not configured.",
      );
    }
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

  if (client && remote) {
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

  const generated = await createVitalHandoffCandidate({
    patient: stored.patient,
    events: [...stored.events, event],
    plans,
    recordedVital: event,
    generatedAt: now,
  });

  try {
    const candidate = (client && remote) ? await createCandidateVersion(input.patientId) : generated.candidate;
    return { event, monitoring: generated.monitoring, candidate };
  } catch (error) {
    if (error instanceof CandidateRefreshError) {
      throw new VitalRecordingError(error.code === "SETUP_REQUIRED" ? "SETUP_REQUIRED" : "PERSISTENCE_FAILED", error.message);
    }
    throw error;
  }
}

export async function recordClinicalUpdate(patientId: string, note: string) {
  const client = createOptionalSupabaseServiceClient();
  let remote: { patient: any; events: any[] } | null = null;
  if (client) {
    try {
      remote = await loadSyntheticPatientAndEvents(patientId);
    } catch {
      remote = null;
    }
  }

  const fixture = createDemoUnit(undefined, true);
  const stored = remote ?? (() => {
    const patient = fixture.patients.find((item) => item.id === patientId);
    return patient ? { patient, events: fixture.chartEvents.filter((event) => event.patientId === patient.id) } : null;
  })();
  if (!stored) throw new VitalRecordingError("NOT_FOUND", "The requested synthetic patient was not found.");

  let plans = fixture.vitalMonitoringPlans.filter((plan) => plan.patientId === patientId);
  if (remote) {
    try {
      plans = await loadSyntheticVitalMonitoringPlans(patientId);
    } catch {
      // use fixture plans
    }
  }

  const parsed = await parseClinicalNoteWithAI(note);
  const now = new Date();
  const events = createChartEventsFromParsedUpdate(patientId, parsed, note, now);
  const primaryEvent = events[0] ?? {
    id: randomUUID(),
    patientId,
    category: "nursing_note" as const,
    occurredAt: now.toISOString(),
    recordedAt: now.toISOString(),
    sourceLabel: "Nurse bedside note (AI parsed)",
    payload: { summary: note },
  };

  if (client && remote) {
    for (const ev of events) {
      await client.from("patient_chart_events").insert({
        id: ev.id,
        patient_id: ev.patientId,
        category: ev.category,
        occurred_at: ev.occurredAt,
        recorded_at: ev.recordedAt,
        source_label: ev.sourceLabel,
        payload: ev.payload,
      });
    }
  }

  const allEvents = [...stored.events, ...events];
  const monitoring = plans.map((plan) => evaluateVitalMonitoring(allEvents, plan));

  let candidate: HandoffVersion;
  if (client && remote) {
    candidate = await createCandidateVersion(patientId);
  } else {
    try {
      const pipeline = createConfiguredPipeline();
      const generated = await pipeline.generate(stored.patient, allEvents, now);
      candidate = generated.status === "failed"
        ? await new HandoffPipeline().generate(stored.patient, allEvents, now)
        : generated;
    } catch {
      candidate = await new HandoffPipeline().generate(stored.patient, allEvents, now);
    }
  }

  return {
    event: primaryEvent,
    allEvents,
    monitoring,
    candidate,
    message: `Parsed as ${parsed.category.replace("_", " ")} and SBAR re-synthesized by Gemini.`,
  };
}

export async function recordSyntheticVitalComment(patientId: string, note: string) {
  try {
    const parsed = extractVitalFromNote(note);
    return await recordSyntheticVital({ patientId, ...parsed });
  } catch {
    // If not a simple single vital sign or missing a preconfigured plan, parse as clinical update with AI
    return await recordClinicalUpdate(patientId, note);
  }
}

