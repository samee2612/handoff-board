import { randomUUID } from "node:crypto";
import type { ChartEvent, HandoffClaim, HandoffVersion, Patient, VitalMonitoringPlan } from "@/lib/contracts";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { displayVitalValue, evaluateVitalMonitoring, valueForVital, vitalLabel, type VitalMonitoringStatus } from "@/lib/vitals/monitoring";

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function monitoringClaim(status: VitalMonitoringStatus, events: ChartEvent[]): HandoffClaim | null {
  if (!status.latestEvent || !status.displayValue || !status.nextDueAt) return null;
  const label = vitalLabel(status.plan.vitalType);
  const priorEvent = events
    .filter((event): event is Extract<ChartEvent, { category: "vital" }> => event.category === "vital")
    .filter((event) => event.id !== status.latestEvent!.id && valueForVital(event, status.plan.vitalType) !== null)
    .sort((left, right) => new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime())[0];
  const prior = priorEvent ? ` Previous ${label} was ${displayVitalValue(priorEvent, status.plan.vitalType)} at ${timeLabel(priorEvent.recordedAt)}.` : "";
  const attention = status.attention === "urgent"
    ? " It is flagged for urgent review under the synthetic monitoring plan."
    : status.attention === "attention"
      ? " It is flagged for attention under the synthetic monitoring plan."
      : " Monitoring remains on the synthetic schedule.";
  return {
    id: `vital-monitoring:${status.plan.id}:${status.latestEvent.id}`,
    section: "recommendation",
    text: `${label} ${status.displayValue} recorded at ${timeLabel(status.latestEvent.recordedAt)}.${prior}${attention} Next ${label} check is due at ${timeLabel(status.nextDueAt)}.`,
    // Measurements are directly cited. The due time is deterministic from the displayed synthetic plan.
    evidenceEventIds: [status.latestEvent.id, ...(priorEvent ? [priorEvent.id] : [])],
  };
}

/**
 * Adds deterministic monitoring continuity to the evidence-grounded multi-agent SBAR draft.
 * This does not diagnose or recommend treatment; it only reports the configured demo plan.
 */
export async function createVitalHandoffCandidate(input: {
  patient: Patient;
  events: ChartEvent[];
  plans: VitalMonitoringPlan[];
  recordedVital: Extract<ChartEvent, { category: "vital" }>;
  generatedAt: Date;
}): Promise<{ candidate: HandoffVersion; monitoring: VitalMonitoringStatus[] }> {
  const generated = await new HandoffPipeline().generate(input.patient, input.events, input.generatedAt);
  const monitoring = input.plans.map((plan) => evaluateVitalMonitoring(input.events, plan));
  const changedPlan = input.plans.find((plan) => evaluateVitalMonitoring([input.recordedVital], plan).latestEvent !== null);
  const claim = changedPlan ? monitoringClaim(monitoring.find((status) => status.plan.id === changedPlan.id)!, input.events) : null;
  const claims = claim && !generated.claims.some((item) => item.id === claim.id) ? [...generated.claims, claim] : generated.claims;
  return {
    candidate: { ...generated, id: randomUUID(), status: generated.status === "failed" ? "failed" : "candidate", claims },
    monitoring,
  };
}
