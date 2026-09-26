import type { ActionAlert, ChartEvent, FreshnessEvaluation, Patient } from "@/lib/contracts";
import type { DemoUnit } from "@/lib/demo/seed-data";
import { evaluateActionAlerts } from "@/lib/engine/alerts";
import { evaluateFreshness } from "@/lib/engine/freshness";

export type FoundationPatientSnapshot = {
  patient: Patient;
  alerts: ActionAlert[];
  freshness: FreshnessEvaluation;
};

export function buildFoundationSnapshot(unit: DemoUnit): { patients: FoundationPatientSnapshot[] } {
  const byPatient = new Map<string, ChartEvent[]>();
  for (const event of unit.chartEvents) {
    const events = byPatient.get(event.patientId) ?? [];
    events.push(event);
    byPatient.set(event.patientId, events);
  }

  return {
    patients: unit.patients.map((patient) => {
      const events = byPatient.get(patient.id) ?? [];
      return {
        patient,
        alerts: evaluateActionAlerts(events, unit.now),
        freshness: evaluateFreshness(events, unit.now),
      };
    }),
  };
}
