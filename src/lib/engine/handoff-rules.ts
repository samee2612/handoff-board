import type {
  ChartEvent,
  ExtractedFact,
  VitalMonitoringPlan,
  VitalType,
} from "@/lib/contracts";

export type HandoffFlag = {
  id: string;
  kind: "urgent_attention" | "data_quality" | "overdue_task";
  message: string;
  evidenceEventIds: string[];
};

export type VitalObservation = {
  vitalType: VitalType;
  value: number;
  diastolicValue?: number;
  eventId: string;
  occurredAt: string;
  recordedAt: string;
};

export type HandoffRuleOptions = {
  trendReadings?: number;
  trendWindowHours?: number;
  systolicDropThreshold?: number;
  heartRateRiseThreshold?: number;
  ranges?: Partial<Record<VitalMeasurement, { min: number; max: number }>>;
};

export type VitalMeasurement =
  | "systolic_blood_pressure"
  | "diastolic_blood_pressure"
  | "heart_rate"
  | "oxygen_saturation"
  | "temperature_celsius"
  | "blood_glucose";

export type HandoffRuleResult = {
  attention: "routine" | "attention" | "urgent" | null;
  nextDueAt: string | null;
  trendFacts: ExtractedFact[];
  flags: HandoffFlag[];
  observations: VitalObservation[];
};

const DEFAULT_RANGES: Record<VitalMeasurement, { min: number; max: number }> = {
  systolic_blood_pressure: { min: 40, max: 260 },
  diastolic_blood_pressure: { min: 20, max: 150 },
  heart_rate: { min: 20, max: 250 },
  oxygen_saturation: { min: 50, max: 100 },
  temperature_celsius: { min: 25, max: 45 },
  blood_glucose: { min: 10, max: 1000 },
};

type ExtractedMeasurement = {
  measurement: VitalMeasurement;
  vitalType: VitalType;
  value: number;
  eventId: string;
  occurredAt: string;
  recordedAt: string;
  diastolicValue?: number;
};

function vitalMeasurements(event: Extract<ChartEvent, { category: "vital" }>): ExtractedMeasurement[] {
  const measurements: ExtractedMeasurement[] = [];
  const add = (
    measurement: VitalMeasurement,
    vitalType: VitalType,
    value: number | undefined,
  ) => {
    if (value !== undefined) {
      measurements.push({
        measurement,
        vitalType,
        value,
        eventId: event.id,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
      });
    }
  };

  add("systolic_blood_pressure", "blood_pressure", event.payload.systolicBloodPressure);
  add("diastolic_blood_pressure", "blood_pressure", event.payload.diastolicBloodPressure);
  add("heart_rate", "heart_rate", event.payload.heartRate);
  add("oxygen_saturation", "oxygen_saturation", event.payload.oxygenSaturation);
  add("temperature_celsius", "temperature", event.payload.temperatureCelsius);
  add("blood_glucose", "blood_glucose", event.payload.bloodGlucose);
  return measurements;
}

function parseNoteMeasurements(event: Extract<ChartEvent, { category: "nursing_note" }>): ExtractedMeasurement[] {
  const summary = event.payload.summary;
  const readings: ExtractedMeasurement[] = [];
  const timestamp = event.occurredAt;
  const bp = summary.match(/(?:\bbp\b|blood pressure)\D*(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})/i);
  if (bp) {
    readings.push(
      {
        measurement: "systolic_blood_pressure",
        vitalType: "blood_pressure",
        value: Number(bp[1]),
        eventId: event.id,
        occurredAt: timestamp,
        recordedAt: event.recordedAt,
        diastolicValue: Number(bp[2]),
      },
      {
        measurement: "diastolic_blood_pressure",
        vitalType: "blood_pressure",
        value: Number(bp[2]),
        eventId: event.id,
        occurredAt: timestamp,
        recordedAt: event.recordedAt,
      },
    );
  }

  const singleValuePatterns: Array<{
    pattern: RegExp;
    measurement: VitalMeasurement;
    vitalType: VitalType;
  }> = [
    { pattern: /(?:heart rate|\bhr\b|\bpulse\b)\D*(\d{2,3})/i, measurement: "heart_rate", vitalType: "heart_rate" },
    { pattern: /(?:\bspo2\b|\bo2\s*(?:sat|saturation)?\b|oxygen saturation)\D*(\d{2,3})\s*%?/i, measurement: "oxygen_saturation", vitalType: "oxygen_saturation" },
    { pattern: /(?:\btemperature\b|\btemp\b)\D*(\d{2}(?:\.\d+)?)/i, measurement: "temperature_celsius", vitalType: "temperature" },
    { pattern: /(?:blood\s*(?:sugar|glucose)|\bglucose\b|\bbgl\b)\D*(\d{2,3}(?:\.\d+)?)/i, measurement: "blood_glucose", vitalType: "blood_glucose" },
  ];

  for (const { pattern, measurement, vitalType } of singleValuePatterns) {
    const match = summary.match(pattern);
    if (match) {
      readings.push({
        measurement,
        vitalType,
        value: Number(match[1]),
        eventId: event.id,
        occurredAt: timestamp,
        recordedAt: event.recordedAt,
      });
    }
  }
  return readings;
}

function hasMalformedBloodPressure(summary: string): boolean {
  const candidate = summary.match(
    /\b(?:bp|blood pressure)\b[^a-z\d\n]*([a-z\d]{2,3})\s*(?:\/|over)\s*([a-z\d]{2,3})/i,
  );
  if (!candidate) return false;
  return !/^\d{2,3}$/.test(candidate[1]) || !/^\d{2,3}$/.test(candidate[2]);
}

function validMeasurement(
  measurement: VitalMeasurement,
  value: number,
  options: HandoffRuleOptions,
): boolean {
  const range = options.ranges?.[measurement] ?? DEFAULT_RANGES[measurement];
  return Number.isFinite(value) && value >= range.min && value <= range.max;
}

function taskFlags(events: ChartEvent[], runAt: Date): HandoffFlag[] {
  const completed = events.flatMap((event) =>
    event.category === "task" &&
    event.payload.status === "completed" &&
    new Date(event.occurredAt).getTime() <= runAt.getTime()
      ? [{ title: event.payload.title.trim().toLocaleLowerCase(), at: new Date(event.occurredAt).getTime() }]
      : [],
  );

  return events.flatMap((event) => {
    if (
      event.category !== "task" ||
      event.payload.status !== "open" ||
      !event.payload.dueAt ||
      new Date(event.payload.dueAt).getTime() >= runAt.getTime() ||
      completed.some((completion) =>
        completion.title === event.payload.title.trim().toLocaleLowerCase() &&
        completion.at >= new Date(event.occurredAt).getTime(),
      )
    ) return [];
    return [{
      id: `overdue-task:${event.id}`,
      kind: "overdue_task" as const,
      message: `Task overdue: ${event.payload.title}`,
      evidenceEventIds: [event.id],
    }];
  });
}

function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...tail] = items;
  const withHead = combinations(tail, k - 1).map((sub) => [head, ...sub]);
  const withoutHead = combinations(tail, k);
  return [...withHead, ...withoutHead];
}

function intervalVariance(readings: VitalObservation[]): number {
  if (readings.length < 2) return 0;
  const intervals: number[] = [];
  for (let i = 0; i < readings.length - 1; i++) {
    intervals.push(
      new Date(readings[i + 1].occurredAt).getTime() - new Date(readings[i].occurredAt).getTime(),
    );
  }
  const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
  return intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0);
}

function trendFacts(
  observations: VitalObservation[],
  runAt: Date,
  options: HandoffRuleOptions,
): ExtractedFact[] {
  const count = options.trendReadings ?? 4;
  const windowMs = (options.trendWindowHours ?? 12) * 60 * 60_000;
  const windowStart = runAt.getTime() - windowMs;
  const results: ExtractedFact[] = [];

  for (const vitalType of ["blood_pressure", "heart_rate"] as const) {
    const readings = observations
      .filter((item) =>
        item.vitalType === vitalType &&
        new Date(item.occurredAt).getTime() >= windowStart &&
        new Date(item.occurredAt).getTime() <= runAt.getTime(),
      )
      .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
    if (readings.length < count) continue;

    const threshold = vitalType === "blood_pressure"
      ? options.systolicDropThreshold ?? 30
      : options.heartRateRiseThreshold ?? 20;

    const candidateSubsets = combinations(readings, count).filter((candidate) => {
      const first = candidate[0];
      const last = candidate[candidate.length - 1];
      const delta = vitalType === "blood_pressure"
        ? first.value - last.value
        : last.value - first.value;
      return delta >= threshold;
    });

    if (candidateSubsets.length === 0) continue;

    candidateSubsets.sort((a, b) => {
      const deltaA = vitalType === "blood_pressure"
        ? a[0].value - a[a.length - 1].value
        : a[a.length - 1].value - a[0].value;
      const deltaB = vitalType === "blood_pressure"
        ? b[0].value - b[b.length - 1].value
        : b[b.length - 1].value - b[0].value;
      if (deltaB !== deltaA) return deltaB - deltaA;
      return intervalVariance(a) - intervalVariance(b);
    });

    const chosen = candidateSubsets[0];
    const first = chosen[0];
    const last = chosen[chosen.length - 1];
    const trendName = vitalType === "blood_pressure" ? "Systolic blood pressure" : "Heart rate";
    const direction = vitalType === "blood_pressure" ? "decreased" : "increased";
    results.push({
      id: `deterministic-trend:${vitalType}:${chosen.map((item) => item.eventId).join(":")}`,
      specialist: "chart_vitals",
      summary: `${trendName} ${direction} from ${first.value} to ${last.value}.`,
      evidenceEventIds: chosen.map((item) => item.eventId),
    });
  }
  return results;
}

function attentionFor(value: number, plan: VitalMonitoringPlan): "routine" | "attention" | "urgent" {
  if (
    (plan.urgentBelow !== undefined && value <= plan.urgentBelow) ||
    (plan.urgentAbove !== undefined && value >= plan.urgentAbove)
  ) return "urgent";
  if (
    (plan.attentionBelow !== undefined && value <= plan.attentionBelow) ||
    (plan.attentionAbove !== undefined && value >= plan.attentionAbove)
  ) return "attention";
  return "routine";
}

/**
 * Applies synthetic demo plausibility, trend, overdue-task, and plan-bound rules.
 * This pure code never diagnoses or recommends treatment.
 */
export function evaluateHandoffRules(
  events: ChartEvent[],
  plan: VitalMonitoringPlan | null,
  runAt: Date,
  options: HandoffRuleOptions = {},
): HandoffRuleResult {
  const readingCount = options.trendReadings ?? 4;
  const windowHours = options.trendWindowHours ?? 8;
  if (!Number.isInteger(readingCount) || readingCount < 2) {
    throw new RangeError("trendReadings must be an integer of at least 2.");
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new RangeError("trendWindowHours must be a positive finite number.");
  }
  for (const [measurement, range] of Object.entries(options.ranges ?? {})) {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max) {
      throw new RangeError(`Invalid plausibility range for ${measurement}.`);
    }
  }

  const flags: HandoffFlag[] = [];
  const extracted = events.flatMap((event) => {
    if (event.category === "vital") return vitalMeasurements(event);
    if (event.category === "nursing_note") {
      const parsed = parseNoteMeasurements(event);
      if (hasMalformedBloodPressure(event.payload.summary)) {
        flags.push({
          id: `unparsed-vital-note:${event.id}`,
          kind: "data_quality",
          message: "Possible typo or unreadable blood-pressure value; it was excluded from calculations.",
          evidenceEventIds: [event.id],
        });
      }
      return parsed;
    }
    return [];
  });

  const observations: VitalObservation[] = [];
  const invalidBloodPressureEvents = new Set<string>();
  for (const item of extracted) {
    if (!validMeasurement(item.measurement, item.value, options)) {
      flags.push({
        id: `implausible:${item.measurement}:${item.eventId}`,
        kind: "data_quality",
        message: `${item.measurement} value ${item.value} is outside the configured synthetic range.`,
        evidenceEventIds: [item.eventId],
      });
      if (
        item.measurement === "systolic_blood_pressure" ||
        item.measurement === "diastolic_blood_pressure"
      ) invalidBloodPressureEvents.add(item.eventId);
      continue;
    }
    if (item.measurement === "diastolic_blood_pressure") continue;
    const observation: VitalObservation = {
      vitalType: item.vitalType,
      value: item.value,
      eventId: item.eventId,
      occurredAt: item.occurredAt,
      recordedAt: item.recordedAt,
    };
    if (item.measurement === "systolic_blood_pressure") {
      observation.diastolicValue = item.diastolicValue;
    }
    observations.push(observation);
  }

  const cleanObservations = observations.filter((item) =>
    item.vitalType !== "blood_pressure" || !invalidBloodPressureEvents.has(item.eventId),
  );
  const trends = trendFacts(cleanObservations, runAt, options);
  const relevant = plan
    ? cleanObservations
        .filter((item) =>
          item.vitalType === plan.vitalType &&
          new Date(item.recordedAt).getTime() <= runAt.getTime(),
        )
        .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())[0]
    : undefined;
  let attention: HandoffRuleResult["attention"] = null;
  let nextDueAt: string | null = null;

  if (plan && relevant) {
    const severity = { routine: 0, attention: 1, urgent: 2 } as const;
    const attentionReading = cleanObservations
      .filter((item) =>
        item.vitalType === plan.vitalType &&
        new Date(item.recordedAt).getTime() <= runAt.getTime(),
      )
      .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
      .reduce((highest, item) =>
        severity[attentionFor(item.value, plan)] > severity[attentionFor(highest.value, plan)]
          ? item
          : highest,
      relevant);
    attention = attentionFor(attentionReading.value, plan);
    nextDueAt = new Date(
      new Date(relevant.recordedAt).getTime() + plan.intervalMinutes * 60_000,
    ).toISOString();
    if (attention === "urgent" || attention === "attention") {
      flags.push({
        id: `monitoring-attention:${attentionReading.eventId}:${attention}`,
        kind: "urgent_attention",
        message: `${plan.vitalType} is marked ${attention} by the configured synthetic monitoring plan.`,
        evidenceEventIds: [attentionReading.eventId],
      });
    }
  }

  flags.push(...taskFlags(events, runAt));
  return { attention, nextDueAt, trendFacts: trends, flags, observations: cleanObservations };
}
