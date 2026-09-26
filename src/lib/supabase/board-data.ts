import "server-only";
import type { HandoffVersion } from "@/lib/contracts";
import { handoffVersionSchema } from "@/lib/contracts";
import { createLiveBoardState, type LiveBoardState } from "@/lib/board/live-board";
import { createDemoUnit, type DemoNurse } from "@/lib/demo/seed-data";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { chartEventFromSupabaseRow, patientFromSupabaseRow } from "@/lib/supabase/mappers";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

export type BoardMode = "fixture" | "realtime" | "degraded";
export type LoadedBoard = LiveBoardState & {
  nurses: DemoNurse[];
  mode: BoardMode;
  sourceMessage?: string;
};

function toNurses(rows: unknown[]): DemoNurse[] {
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const value = row as Record<string, unknown>;
    return typeof value.id === "string" && typeof value.display_name === "string"
      ? [{ id: value.id, displayName: value.display_name }]
      : [];
  });
}

function toHandoff(row: unknown): HandoffVersion | null {
  if (typeof row !== "object" || row === null) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.content !== "object" || value.content === null) return null;
  const content = value.content as Record<string, unknown>;
  const parsed = handoffVersionSchema.safeParse({
    ...content,
    id: value.id,
    versionNumber: value.version_number,
    patientId: value.patient_id,
    sourceEventCutoff: value.source_event_cutoff,
    generatedAt: value.generated_at,
    model: value.model,
    status: value.status,
    failure: value.status === "failed"
      ? { code: value.failure_code, message: value.failure_message }
      : null,
  });
  return parsed.success ? parsed.data : null;
}

async function fixtureBoard(mode: Exclude<BoardMode, "realtime">, sourceMessage?: string): Promise<LoadedBoard> {
  const demo = createDemoUnit();
  const pipeline = new HandoffPipeline();
  const handoffs = await Promise.all(demo.patients.map((patient) => pipeline.generate(
    patient,
    demo.chartEvents.filter((event) => event.patientId === patient.id),
    demo.now,
  )));
  return { ...createLiveBoardState({ patients: demo.patients, events: demo.chartEvents, handoffs, now: demo.now }), nurses: demo.nurses, mode, sourceMessage };
}

/** Loads Supabase only when all server-safe configuration is present; otherwise the fixture remains usable. */
export async function loadBoard(): Promise<LoadedBoard> {
  const client = createOptionalSupabaseServiceClient();
  if (!client) return fixtureBoard("fixture");

  try {
    const [patientsResult, eventsResult, nursesResult, versionsResult] = await Promise.all([
      client.from("patients").select("id, unit_id, is_synthetic, display_name, room, assigned_nurse_id, admitted_at").order("room"),
      client.from("patient_chart_events").select("id, patient_id, category, occurred_at, recorded_at, source_label, payload").order("recorded_at"),
      client.from("nurses").select("id, display_name").order("display_name"),
      client.from("handoff_versions").select("id, version_number, patient_id, source_event_cutoff, generated_at, model, status, content, failure_code, failure_message").order("version_number", { ascending: false }),
    ]);
    const error = [patientsResult.error, eventsResult.error, nursesResult.error, versionsResult.error].find(Boolean);
    if (error) throw error;
    const patients = (patientsResult.data ?? []).flatMap((row) => {
      const patient = patientFromSupabaseRow(row);
      return patient ? [patient] : [];
    });
    const events = (eventsResult.data ?? []).flatMap((row) => {
      const event = chartEventFromSupabaseRow(row);
      return event && patients.some((patient) => patient.id === event.patientId) ? [event] : [];
    });
    const persisted = (versionsResult.data ?? []).flatMap((row) => {
      const version = toHandoff(row);
      return version && patients.some((patient) => patient.id === version.patientId) ? [version] : [];
    });
    const latestByPatient = new Map<string, HandoffVersion>();
    for (const version of persisted) {
      if (!latestByPatient.has(version.patientId)) latestByPatient.set(version.patientId, version);
    }
    const missingPatients = patients.filter((patient) => !latestByPatient.has(patient.id));
    const pipeline = new HandoffPipeline();
    const initial = await Promise.all(missingPatients.map((patient) => pipeline.generate(
      patient,
      events.filter((event) => event.patientId === patient.id),
      new Date(),
    )));
    return {
      ...createLiveBoardState({ patients, events, handoffs: [...latestByPatient.values(), ...initial], now: new Date() }),
      nurses: toNurses(nursesResult.data ?? []),
      mode: "realtime",
    };
  } catch {
    return fixtureBoard("degraded", "Supabase could not be read. Showing the local synthetic fixture; no live source events are connected.");
  }
}

export async function loadSyntheticPatientAndEvents(patientId: string) {
  const client = createOptionalSupabaseServiceClient();
  if (!client) return null;
  const [patientResult, eventsResult] = await Promise.all([
    client.from("patients").select("id, unit_id, is_synthetic, display_name, room, assigned_nurse_id, admitted_at").eq("id", patientId).maybeSingle(),
    client.from("patient_chart_events").select("id, patient_id, category, occurred_at, recorded_at, source_label, payload").eq("patient_id", patientId).order("recorded_at"),
  ]);
  if (patientResult.error || eventsResult.error) throw patientResult.error ?? eventsResult.error;
  const patient = patientFromSupabaseRow(patientResult.data);
  if (!patient) return null;
  const events = (eventsResult.data ?? []).flatMap((row) => {
    const event = chartEventFromSupabaseRow(row);
    return event ? [event] : [];
  });
  return { patient, events };
}
