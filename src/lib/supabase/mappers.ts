import { chartEventSchema, handoffVersionSchema, patientSchema, vitalMonitoringPlanSchema, type ChartEvent, type HandoffVersion, type Patient, type VitalMonitoringPlan } from "@/lib/contracts";

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordLike : null;
}

/** Maps the deliberately small public source-event shape at the browser/server boundary. */
export function chartEventFromSupabaseRow(row: unknown): ChartEvent | null {
  const value = asRecord(row);
  if (!value) return null;
  const parsed = chartEventSchema.safeParse({
    id: value.id,
    patientId: value.patient_id,
    category: value.category,
    occurredAt: value.occurred_at,
    recordedAt: value.recorded_at,
    sourceLabel: value.source_label,
    payload: value.payload,
  });
  return parsed.success ? parsed.data : null;
}

export function patientFromSupabaseRow(row: unknown): Patient | null {
  const value = asRecord(row);
  if (!value) return null;
  const parsed = patientSchema.safeParse({
    id: value.id,
    unitId: value.unit_id,
    isSynthetic: value.is_synthetic,
    displayName: value.display_name,
    room: value.room,
    assignedNurseId: value.assigned_nurse_id,
    admittedAt: value.admitted_at,
  });
  return parsed.success ? parsed.data : null;
}

export function vitalMonitoringPlanFromSupabaseRow(row: unknown): VitalMonitoringPlan | null {
  const value = asRecord(row);
  if (!value) return null;
  const parsed = vitalMonitoringPlanSchema.safeParse({
    id: value.id,
    patientId: value.patient_id,
    vitalType: value.vital_type,
    intervalMinutes: value.interval_minutes,
    attentionBelow: value.attention_below === null ? undefined : value.attention_below,
    attentionAbove: value.attention_above === null ? undefined : value.attention_above,
    urgentBelow: value.urgent_below === null ? undefined : value.urgent_below,
    urgentAbove: value.urgent_above === null ? undefined : value.urgent_above,
  });
  return parsed.success ? parsed.data : null;
}

/** Maps a persisted immutable handoff row and validates its embedded structured content. */
export function handoffVersionFromSupabaseRow(row: unknown): HandoffVersion | null {
  const value = asRecord(row);
  if (!value || !asRecord(value.content)) return null;
  const content = value.content as RecordLike;
  const parsed = handoffVersionSchema.safeParse({
    ...content,
    id: value.id,
    versionNumber: value.version_number,
    patientId: value.patient_id,
    sourceEventCutoff: value.source_event_cutoff,
    generatedAt: value.generated_at,
    model: value.model,
    status: value.status,
    failure: value.status === "failed" ? { code: value.failure_code, message: value.failure_message } : null,
  });
  return parsed.success ? parsed.data : null;
}
