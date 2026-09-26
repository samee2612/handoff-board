import { describe, expect, it } from "vitest";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { chartEventFromSupabaseRow, patientFromSupabaseRow } from "@/lib/supabase/mappers";

describe("Supabase source mappers", () => {
  it("accepts only contract-valid synthetic source rows", () => {
    const unit = createDemoUnit();
    const patient = unit.patients[0];
    const event = unit.chartEvents[0];
    expect(patientFromSupabaseRow({
      id: patient.id, unit_id: patient.unitId, is_synthetic: true, display_name: patient.displayName,
      room: patient.room, assigned_nurse_id: patient.assignedNurseId, admitted_at: patient.admittedAt,
    })).toEqual(patient);
    expect(chartEventFromSupabaseRow({
      id: event.id, patient_id: event.patientId, category: event.category, occurred_at: event.occurredAt,
      recorded_at: event.recordedAt, source_label: event.sourceLabel, payload: event.payload,
    })).toEqual(event);
    expect(patientFromSupabaseRow({ ...patient, is_synthetic: false })).toBeNull();
    expect(chartEventFromSupabaseRow({ id: event.id })).toBeNull();
  });
});
