import type { ChartEvent, VitalMonitoringPlan, VitalType } from "@/lib/contracts";

export type VitalAttention = "routine" | "attention" | "urgent";

export type VitalMonitoringStatus = {
  plan: VitalMonitoringPlan;
  latestEvent: Extract<ChartEvent, { category: "vital" }> | null;
  value: number | null;
  displayValue: string | null;
  nextDueAt: string | null;
  attention: VitalAttention;
};

const labels: Record<VitalType, string> = {
  blood_pressure: "BP",
  heart_rate: "Heart rate",
  temperature: "Temperature",
  oxygen_saturation: "Oxygen saturation",
  blood_glucose: "Blood glucose",
};

export function vitalLabel(type: VitalType): string {
  return labels[type];
}

export function valueForVital(event: Extract<ChartEvent, { category: "vital" }>, type: VitalType): number | null {
  switch (type) {
    case "blood_pressure": return event.payload.systolicBloodPressure ?? null;
    case "heart_rate": return event.payload.heartRate ?? null;
    case "temperature": return event.payload.temperatureCelsius ?? null;
    case "oxygen_saturation": return event.payload.oxygenSaturation ?? null;
    case "blood_glucose": return event.payload.bloodGlucose ?? null;
  }
}

export function displayVitalValue(event: Extract<ChartEvent, { category: "vital" }>, type: VitalType): string | null {
  const value = valueForVital(event, type);
  if (value === null) return null;
  if (type === "blood_pressure") {
    return event.payload.diastolicBloodPressure === undefined ? `${value}` : `${value}/${event.payload.diastolicBloodPressure}`;
  }
  if (type === "temperature") return `${value} °C`;
  if (type === "oxygen_saturation") return `${value}%`;
  return `${value}`;
}

function attentionFor(value: number | null, plan: VitalMonitoringPlan): VitalAttention {
  if (value === null) return "routine";
  if ((plan.urgentBelow !== undefined && value <= plan.urgentBelow) || (plan.urgentAbove !== undefined && value >= plan.urgentAbove)) return "urgent";
  if ((plan.attentionBelow !== undefined && value <= plan.attentionBelow) || (plan.attentionAbove !== undefined && value >= plan.attentionAbove)) return "attention";
  return "routine";
}

/** Returns the last relevant reading and its next synthetic monitoring time. */
export function evaluateVitalMonitoring(events: ChartEvent[], plan: VitalMonitoringPlan): VitalMonitoringStatus {
  const latestEvent = events
    .filter((event): event is Extract<ChartEvent, { category: "vital" }> => event.category === "vital")
    .filter((event) => valueForVital(event, plan.vitalType) !== null)
    .sort((left, right) => new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime())[0] ?? null;
  const value = latestEvent ? valueForVital(latestEvent, plan.vitalType) : null;
  return {
    plan,
    latestEvent,
    value,
    displayValue: latestEvent ? displayVitalValue(latestEvent, plan.vitalType) : null,
    nextDueAt: latestEvent ? new Date(new Date(latestEvent.recordedAt).getTime() + plan.intervalMinutes * 60_000).toISOString() : null,
    attention: attentionFor(value, plan),
  };
}
