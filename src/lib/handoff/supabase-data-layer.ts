import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handoffPublicationSchema,
  type ChartEvent,
  type HandoffPublication,
  type HandoffVersion,
  type VitalMonitoringPlan,
} from "@/lib/contracts";
import {
  chartEventFromSupabaseRow,
  handoffVersionFromSupabaseRow,
  patientFromSupabaseRow,
  vitalMonitoringPlanFromSupabaseRow,
} from "@/lib/supabase/mappers";
import type {
  HandoffDataLayer,
  HandoffVersionDraft,
  ProtocolChunk,
  PublicationDraft,
} from "@/lib/handoff/data-layer";
import {
  GeminiProtocolEmbedder,
  type ProtocolEmbeddingProvider,
} from "@/lib/handoff/gemini-embeddings";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function vitalTypeFor(event: ChartEvent): VitalMonitoringPlan["vitalType"] | null {
  if (event.category !== "vital") return null;
  if (event.payload.systolicBloodPressure !== undefined) return "blood_pressure";
  if (event.payload.heartRate !== undefined) return "heart_rate";
  if (event.payload.temperatureCelsius !== undefined) return "temperature";
  if (event.payload.oxygenSaturation !== undefined) return "oxygen_saturation";
  if (event.payload.bloodGlucose !== undefined) return "blood_glucose";
  return null;
}

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

/** Supabase-backed ports used by the server graph; all returned records are contract-validated. */
export class SupabaseHandoffDataLayer implements HandoffDataLayer {
  constructor(
    private readonly client: SupabaseClient,
    private readonly embedder: ProtocolEmbeddingProvider = new GeminiProtocolEmbedder(),
  ) {}

  async getPatient(patientId: string) {
    const { data, error } = await this.client
      .from("patients")
      .select("id, unit_id, is_synthetic, display_name, room, assigned_nurse_id, admitted_at")
      .eq("id", patientId)
      .maybeSingle();
    if (error) throw new Error(`Could not load synthetic patient: ${error.message}`);
    if (!data) return null;
    return required(patientFromSupabaseRow(data), "Patient row is invalid or not marked synthetic.");
  }

  async getEvents(patientId: string): Promise<ChartEvent[]> {
    const { data, error } = await this.client
      .from("patient_chart_events")
      .select("id, patient_id, category, occurred_at, recorded_at, source_label, payload")
      .eq("patient_id", patientId)
      .order("recorded_at", { ascending: true });
    if (error) throw new Error(`Could not load patient events: ${error.message}`);
    return (data ?? []).map((row) =>
      required(chartEventFromSupabaseRow(row), "A patient event failed schema validation."),
    );
  }

  async getPlan(patientId: string, triggerEventId: string): Promise<VitalMonitoringPlan | null> {
    const events = await this.getEvents(patientId);
    const trigger = events.find((event) => event.id === triggerEventId);
    const vitalType = trigger ? vitalTypeFor(trigger) : null;
    if (!vitalType) return null;

    const { data, error } = await this.client
      .from("patient_vital_monitoring_plans")
      .select("id, patient_id, vital_type, interval_minutes, attention_below, attention_above, urgent_below, urgent_above")
      .eq("patient_id", patientId)
      .eq("vital_type", vitalType)
      .maybeSingle();
    if (error) throw new Error(`Could not load the monitoring plan: ${error.message}`);
    if (!data) return null;
    return required(vitalMonitoringPlanFromSupabaseRow(data), "Monitoring plan row failed schema validation.");
  }

  async retrieve(query: string, limit: number): Promise<ProtocolChunk[]> {
    const boundedLimit = Math.min(3, Math.max(0, Math.floor(limit)));
    if (boundedLimit === 0) return [];

    const embedding = await this.embedder.embed(query, "RETRIEVAL_QUERY");
    const { data, error } = await this.client.rpc("match_knowledge_chunks", {
      query_embedding: embedding,
      match_count: boundedLimit,
    });
    if (error) throw new Error(`Could not retrieve protocol context: ${error.message}`);
    if (!Array.isArray(data)) throw new Error("Protocol retrieval returned an invalid response.");

    return data.map((value) => {
      const row = record(value);
      if (typeof row?.id !== "string" || typeof row.content !== "string" || !row.content.trim()) {
        throw new Error("A retrieved protocol chunk failed schema validation.");
      }
      return { id: row.id, text: row.content };
    });
  }

  async append(draft: HandoffVersionDraft): Promise<HandoffVersion> {
    const id = randomUUID();
    const { data, error } = await this.client.rpc("append_handoff_version", {
      p_id: id,
      p_patient_id: draft.patientId,
      p_source_event_cutoff: draft.sourceEventCutoff,
      p_status: draft.status,
      p_model: draft.model,
      p_generated_at: draft.generatedAt,
      p_content: { ...draft, id, versionNumber: 1 },
      p_evidence_gap_count: draft.excludedClaims.length,
      p_failure_code: draft.failure?.code ?? null,
      p_failure_message: draft.failure?.message ?? null,
    }).single();
    if (error || !data) throw new Error(`Could not append handoff version: ${error?.message ?? "empty database response"}`);
    const row = record(data);
    const version = handoffVersionFromSupabaseRow({
      ...draft,
      ...row,
      id: row?.version_id ?? id,
      version_number: row?.version_number,
      patient_id: draft.patientId,
      source_event_cutoff: draft.sourceEventCutoff,
      generated_at: draft.generatedAt,
      model: draft.model,
      status: draft.status,
      content: draft,
      failure_code: draft.failure?.code ?? null,
      failure_message: draft.failure?.message ?? null,
    });
    return required(version, "Persisted handoff version failed schema validation.");
  }

  async get(versionId: string): Promise<HandoffVersion | null> {
    const { data, error } = await this.client
      .from("handoff_versions")
      .select("id, version_number, patient_id, source_event_cutoff, generated_at, model, status, content, failure_code, failure_message")
      .eq("id", versionId)
      .maybeSingle();
    if (error) throw new Error(`Could not load handoff version: ${error.message}`);
    if (!data) return null;
    return required(handoffVersionFromSupabaseRow(data), "Persisted handoff version failed schema validation.");
  }

  async list(patientId: string): Promise<HandoffVersion[]> {
    const { data, error } = await this.client
      .from("handoff_versions")
      .select("id, version_number, patient_id, source_event_cutoff, generated_at, model, status, content, failure_code, failure_message")
      .eq("patient_id", patientId)
      .order("version_number", { ascending: true });
    if (error) throw new Error(`Could not list handoff versions: ${error.message}`);
    return (data ?? []).map((row) =>
      required(handoffVersionFromSupabaseRow(row), "A persisted handoff version failed schema validation."),
    );
  }

  async registerReviewThread(versionId: string, threadId: string): Promise<void> {
    const { error } = await this.client.from("handoff_graph_runs").insert({
      handoff_version_id: versionId,
      thread_id: threadId,
    });
    if (error) throw new Error(`Could not register the review checkpoint: ${error.message}`);
  }

  async getReviewThreadId(versionId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("handoff_graph_runs")
      .select("thread_id")
      .eq("handoff_version_id", versionId)
      .maybeSingle();
    if (error) throw new Error(`Could not load the review checkpoint: ${error.message}`);
    if (!data) return null;
    return required(
      typeof data.thread_id === "string" ? data.thread_id : null,
      "Review checkpoint row has no thread ID.",
    );
  }

  async appendPublication(draft: PublicationDraft): Promise<HandoffPublication> {
    const { data: approval, error: approvalError } = await this.client
      .from("handoff_reviews")
      .select("nurse_id, note")
      .eq("handoff_version_id", draft.handoffVersionId)
      .eq("action", "approved")
      .order("reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (approvalError) throw new Error(`Could not verify explicit approval: ${approvalError.message}`);
    if (!approval) throw new Error("A recorded approval is required before publication.");

    const { data, error } = await this.client.rpc("publish_candidate_handoff", {
      p_handoff_version_id: draft.handoffVersionId,
      p_nurse_id: approval.nurse_id,
      p_note: approval.note,
    }).single();
    if (error || !data) throw new Error(`Could not append publication: ${error?.message ?? "empty database response"}`);
    const row = record(data);
    return required(handoffPublicationSchema.safeParse({
      id: row?.publication_id,
      patientId: row?.patient_id,
      handoffVersionId: row?.handoff_version_id,
      publishedByNurseId: row?.published_by_nurse_id,
      note: row?.note,
      publishedAt: row?.published_at,
    }).data ?? null, "Publication row failed schema validation.");
  }

  async listPublications(patientId: string): Promise<HandoffPublication[]> {
    const { data, error } = await this.client
      .from("handoff_publications")
      .select("id, patient_id, handoff_version_id, published_by_nurse_id, note, published_at")
      .eq("patient_id", patientId)
      .order("published_at", { ascending: true });
    if (error) throw new Error(`Could not list publications: ${error.message}`);
    return (data ?? []).map((row) =>
      required(handoffPublicationSchema.safeParse({
        id: row.id,
        patientId: row.patient_id,
        handoffVersionId: row.handoff_version_id,
        publishedByNurseId: row.published_by_nurse_id,
        note: row.note,
        publishedAt: row.published_at,
      }).data ?? null, "A publication row failed schema validation."),
    );
  }
}
