import { chartEventSchema, patientSchema, type ChartEvent, type Patient } from "@/lib/contracts";

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
