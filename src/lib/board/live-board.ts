import { handoffVersionSchema, type ChartEvent, type HandoffVersion, type Patient } from "@/lib/contracts";
import { evaluateActionAlerts } from "@/lib/engine/alerts";
import { evaluateFreshness } from "@/lib/engine/freshness";
import type { FoundationPatientSnapshot } from "@/lib/engine/board";

export type LiveBoardState = {
  events: ChartEvent[];
  snapshots: FoundationPatientSnapshot[];
  handoffs: HandoffVersion[];
  evaluatedAt: string;
};

export function snapshotsFor(patients: Patient[], events: ChartEvent[], now: Date): FoundationPatientSnapshot[] {
  return patients.map((patient) => {
    const patientEvents = events.filter((event) => event.patientId === patient.id);
    return {
      patient,
      alerts: evaluateActionAlerts(patientEvents, now),
      freshness: evaluateFreshness(patientEvents, now),
    };
  });
}

export function createLiveBoardState(input: {
  patients: Patient[];
  events: ChartEvent[];
  handoffs: HandoffVersion[];
  now: Date;
}): LiveBoardState {
  return {
    events: input.events,
    snapshots: snapshotsFor(input.patients, input.events, input.now),
    handoffs: input.handoffs,
    evaluatedAt: input.now.toISOString(),
  };
}

/** A source event received after a version's cutoff means the displayed handoff needs an explicit refresh. */
export function isHandoffStale(version: HandoffVersion, events: ChartEvent[]): boolean {
  const cutoff = new Date(version.sourceEventCutoff).getTime();
  return events.some((event) => event.patientId === version.patientId && new Date(event.recordedAt).getTime() > cutoff);
}

export function applySourceEvent(state: LiveBoardState, event: ChartEvent, now: Date): LiveBoardState {
  const existing = state.events.findIndex((item) => item.id === event.id);
  const events = existing === -1
    ? [...state.events, event]
    : state.events.map((item) => item.id === event.id ? event : item);
  return {
    ...state,
    events,
    snapshots: snapshotsFor(state.snapshots.map((snapshot) => snapshot.patient), events, now),
    evaluatedAt: now.toISOString(),
  };
}

/** A candidate is immutable once created; it replaces the tile's displayed version but is not auto-published. */
export function applyCandidateVersion(state: LiveBoardState, value: HandoffVersion): LiveBoardState {
  const candidate = handoffVersionSchema.parse(value);
  const current = state.handoffs.findIndex((version) => version.patientId === candidate.patientId);
  return {
    ...state,
    handoffs: current === -1
      ? [...state.handoffs, candidate]
      : state.handoffs.map((version, index) => index === current ? candidate : version),
  };
}
