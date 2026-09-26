import "server-only";
import type { HandoffPublication, HandoffReview, HandoffVersion, VitalMonitoringPlan } from "@/lib/contracts";
import { handoffPublicationSchema, handoffReviewSchema } from "@/lib/contracts";
import { createLiveBoardState, type LiveBoardState } from "@/lib/board/live-board";
import { createDemoUnit, type DemoNurse } from "@/lib/demo/seed-data";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { chartEventFromSupabaseRow, handoffVersionFromSupabaseRow, patientFromSupabaseRow, vitalMonitoringPlanFromSupabaseRow } from "@/lib/supabase/mappers";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

export type BoardMode = "fixture" | "realtime" | "degraded";
export type LoadedBoard = LiveBoardState & {
  nurses: DemoNurse[];
  vitalMonitoringPlans: VitalMonitoringPlan[];
  candidates: HandoffVersion[];
  reviews: HandoffReview[];
  publications: HandoffPublication[];
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

function toReview(row: unknown, nurseNames: Map<string, string>): HandoffReview | null {
  if (typeof row !== "object" || row === null) return null;
  const value = row as Record<string, unknown>;
  const parsed = handoffReviewSchema.safeParse({
    id: value.id,
    handoffVersionId: value.handoff_version_id,
    nurseId: value.nurse_id,
    nurseName: nurseNames.get(String(value.nurse_id)) ?? "Unknown fictional nurse",
    action: value.action,
    note: value.note,
    reviewedAt: value.reviewed_at,
  });
  return parsed.success ? parsed.data : null;
}

function toPublication(row: unknown): HandoffPublication | null {
  if (typeof row !== "object" || row === null) return null;
  const value = row as Record<string, unknown>;
  const parsed = handoffPublicationSchema.safeParse({
    id: value.id,
    patientId: value.patient_id,
    handoffVersionId: value.handoff_version_id,
    publishedByNurseId: value.published_by_nurse_id,
    note: value.note,
    publishedAt: value.published_at,
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
  return {
    ...createLiveBoardState({ patients: demo.patients, events: demo.chartEvents, handoffs, now: demo.now }),
    nurses: demo.nurses,
    vitalMonitoringPlans: demo.vitalMonitoringPlans,
    candidates: [],
    reviews: [],
    publications: [],
    mode,
    sourceMessage,
  };
}

/** Loads Supabase only when all server-safe configuration is present; otherwise the fixture remains usable. */
export async function loadBoard(): Promise<LoadedBoard> {
  const client = createOptionalSupabaseServiceClient();
  if (!client) return fixtureBoard("fixture");

  try {
    const [patientsResult, eventsResult, plansResult, nursesResult, versionsResult, reviewsResult, publicationsResult] = await Promise.all([
      client.from("patients").select("id, unit_id, is_synthetic, display_name, room, assigned_nurse_id, admitted_at").order("room"),
      client.from("patient_chart_events").select("id, patient_id, category, occurred_at, recorded_at, source_label, payload").order("recorded_at"),
      client.from("patient_vital_monitoring_plans").select("id, patient_id, vital_type, interval_minutes, attention_below, attention_above, urgent_below, urgent_above"),
      client.from("nurses").select("id, display_name").order("display_name"),
      client.from("handoff_versions").select("id, version_number, patient_id, source_event_cutoff, generated_at, model, status, content, failure_code, failure_message").order("version_number", { ascending: false }),
      client.from("handoff_reviews").select("id, handoff_version_id, nurse_id, action, note, reviewed_at").order("reviewed_at", { ascending: false }),
      client.from("handoff_publications").select("id, patient_id, handoff_version_id, published_by_nurse_id, note, published_at").order("published_at", { ascending: false }),
    ]);
    const error = [patientsResult.error, eventsResult.error, plansResult.error, nursesResult.error, versionsResult.error, reviewsResult.error, publicationsResult.error].find(Boolean);
    if (error) throw error;
    const patients = (patientsResult.data ?? []).flatMap((row) => {
      const patient = patientFromSupabaseRow(row);
      return patient ? [patient] : [];
    });
    const events = (eventsResult.data ?? []).flatMap((row) => {
      const event = chartEventFromSupabaseRow(row);
      return event && patients.some((patient) => patient.id === event.patientId) ? [event] : [];
    });
    const vitalMonitoringPlans = (plansResult.data ?? []).flatMap((row) => {
      const plan = vitalMonitoringPlanFromSupabaseRow(row);
      return plan && patients.some((patient) => patient.id === plan.patientId) ? [plan] : [];
    });
    const nurseNames = new Map((nursesResult.data ?? []).flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const value = row as Record<string, unknown>;
      return typeof value.id === "string" && typeof value.display_name === "string" ? [[value.id, value.display_name] as const] : [];
    }));
    const persisted = (versionsResult.data ?? []).flatMap((row) => {
      const version = handoffVersionFromSupabaseRow(row);
      return version && patients.some((patient) => patient.id === version.patientId) ? [version] : [];
    });
    const reviews = (reviewsResult.data ?? []).flatMap((row) => {
      const review = toReview(row, nurseNames);
      return review ? [review] : [];
    });
    const publications = (publicationsResult.data ?? []).flatMap((row) => {
      const publication = toPublication(row);
      return publication && patients.some((patient) => patient.id === publication.patientId) ? [publication] : [];
    });
    const publishedByPatient = new Map<string, HandoffVersion>();
    for (const publication of publications) {
      if (publishedByPatient.has(publication.patientId)) continue;
      const version = persisted.find((item) => item.id === publication.handoffVersionId);
      if (version) publishedByPatient.set(publication.patientId, { ...version, status: "published" });
    }
    // Compatibility for a Supabase project that has not yet applied the workflow migration.
    for (const version of persisted) {
      if (version.status === "published" && !publishedByPatient.has(version.patientId)) {
        publishedByPatient.set(version.patientId, version);
      }
    }
    const publishedVersionIds = new Set([...publishedByPatient.values()].map((version) => version.id));
    const candidates = persisted.filter((version) => version.status === "candidate" && !publishedVersionIds.has(version.id));
    const missingPatients = patients.filter((patient) => !publishedByPatient.has(patient.id));
    const pipeline = new HandoffPipeline();
    const initial = await Promise.all(missingPatients.map((patient) => pipeline.generate(
      patient,
      events.filter((event) => event.patientId === patient.id),
      new Date(),
    )));
    return {
      ...createLiveBoardState({ patients, events, handoffs: [...publishedByPatient.values(), ...initial], now: new Date() }),
      nurses: toNurses(nursesResult.data ?? []),
      vitalMonitoringPlans,
      candidates,
      reviews,
      publications,
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

export async function loadSyntheticVitalMonitoringPlans(patientId: string): Promise<VitalMonitoringPlan[]> {
  const client = createOptionalSupabaseServiceClient();
  if (!client) return createDemoUnit().vitalMonitoringPlans.filter((plan) => plan.patientId === patientId);
  const result = await client
    .from("patient_vital_monitoring_plans")
    .select("id, patient_id, vital_type, interval_minutes, attention_below, attention_above, urgent_below, urgent_above")
    .eq("patient_id", patientId);
  if (result.error) throw result.error;
  return (result.data ?? []).flatMap((row) => {
    const plan = vitalMonitoringPlanFromSupabaseRow(row);
    return plan ? [plan] : [];
  });
}
