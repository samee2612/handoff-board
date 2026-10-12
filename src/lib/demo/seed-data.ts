import type { ChartEvent, Patient, VitalMonitoringPlan } from "@/lib/contracts";

const IDs = {
  unit: "11111111-1111-4111-8111-111111111111",
  nurse: "22222222-2222-4222-8222-222222222222",
  ava: "33333333-3333-4333-8333-333333333333",
  ben: "44444444-4444-4444-8444-444444444444",
  clara: "55555555-5555-4555-8555-555555555555",
  david: "88888888-8888-4888-8888-888888888888",
};

export type DemoNurse = { id: string; displayName: string };
export type DemoUnit = { now: Date; patients: Patient[]; chartEvents: ChartEvent[]; vitalMonitoringPlans: VitalMonitoringPlan[]; nurses: DemoNurse[] };

const iso = (date: Date) => date.toISOString();
const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);
const minutesAfter = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000);

/** Creates repeatable fictional data relative to a controllable demo clock. */
export function createDemoUnit(
  now = new Date("2026-09-26T19:00:00.000Z"),
  includeMessy = false,
): DemoUnit {
  const nurses: DemoNurse[] = [
    { id: IDs.nurse, displayName: "Jamie Rivera, RN (fictional)" },
    { id: "66666666-6666-4666-8666-666666666666", displayName: "Morgan Lee, RN (fictional)" },
  ];
  const patients: Patient[] = [
    {
      id: IDs.ava,
      unitId: IDs.unit,
      isSynthetic: true,
      displayName: "Ava Miller (fictional)",
      room: "401-A",
      assignedNurseId: IDs.nurse,
      admittedAt: iso(minutesBefore(now, 38 * 60)),
    },
    {
      id: IDs.ben,
      unitId: IDs.unit,
      isSynthetic: true,
      displayName: "Ben Carter (fictional)",
      room: "401-B",
      assignedNurseId: "66666666-6666-4666-8666-666666666666",
      admittedAt: iso(minutesBefore(now, 19 * 60)),
    },
    {
      id: IDs.clara,
      unitId: IDs.unit,
      isSynthetic: true,
      displayName: "Clara Reed (fictional)",
      room: "402-A",
      assignedNurseId: IDs.nurse,
      admittedAt: iso(minutesBefore(now, 12 * 60)),
    },
  ];

  const event = <T extends ChartEvent>(value: T): T => value;
  const vitalMonitoringPlans: VitalMonitoringPlan[] = [
    { id: "77777777-7777-4777-8777-777777777771", patientId: IDs.ava, vitalType: "blood_pressure", intervalMinutes: 240, attentionBelow: 95, urgentBelow: 85 },
    { id: "77777777-7777-4777-8777-777777777772", patientId: IDs.ava, vitalType: "oxygen_saturation", intervalMinutes: 240, attentionBelow: 93, urgentBelow: 89 },
    { id: "77777777-7777-4777-8777-777777777773", patientId: IDs.ben, vitalType: "blood_pressure", intervalMinutes: 240, attentionBelow: 95, urgentBelow: 85 },
    { id: "77777777-7777-4777-8777-777777777774", patientId: IDs.ben, vitalType: "heart_rate", intervalMinutes: 720, attentionAbove: 110, urgentAbove: 130 },
    { id: "77777777-7777-4777-8777-777777777775", patientId: IDs.clara, vitalType: "oxygen_saturation", intervalMinutes: 120, attentionBelow: 93, urgentBelow: 89 },
    { id: "77777777-7777-4777-8777-777777777776", patientId: IDs.clara, vitalType: "blood_glucose", intervalMinutes: 360, attentionBelow: 70, urgentBelow: 55, attentionAbove: 180, urgentAbove: 250 },
  ];
  const chartEvents: ChartEvent[] = [
    event({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      patientId: IDs.ava,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 30)),
      recordedAt: iso(minutesBefore(now, 28)),
      sourceLabel: "Fictional nursing progress note",
      payload: { summary: "Resting in bed; reports surgical-site pain at 6/10." },
    }),
    event({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      patientId: IDs.ava,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 45)),
      recordedAt: iso(minutesBefore(now, 44)),
      sourceLabel: "Fictional vital-sign record",
      payload: { heartRate: 88, systolicBloodPressure: 128, diastolicBloodPressure: 76, oxygenSaturation: 97 },
    }),
    event({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      patientId: IDs.ava,
      category: "medication",
      occurredAt: iso(minutesBefore(now, 120)),
      recordedAt: iso(minutesBefore(now, 119)),
      sourceLabel: "Fictional MAR",
      payload: {
        medicationName: "Acetaminophen",
        dose: "650 mg",
        route: "oral",
        scheduleType: "scheduled",
        dueAt: iso(minutesAfter(now, 40)),
        status: "active",
      },
    }),
    event({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      patientId: IDs.ava,
      category: "task",
      occurredAt: iso(minutesBefore(now, 60)),
      recordedAt: iso(minutesBefore(now, 60)),
      sourceLabel: "Fictional care task list",
      payload: { title: "Reinforce ambulation plan", dueAt: iso(minutesAfter(now, 20)), status: "open" },
    }),
    event({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      patientId: IDs.ben,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 9 * 60)),
      recordedAt: iso(minutesBefore(now, 9 * 60 - 4)),
      sourceLabel: "Fictional nursing progress note",
      payload: { summary: "Reports intermittent pain; no new concerns documented." },
    }),
    event({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      patientId: IDs.ben,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 5 * 60)),
      recordedAt: iso(minutesBefore(now, 5 * 60 - 2)),
      sourceLabel: "Fictional vital-sign record",
      payload: { heartRate: 92, systolicBloodPressure: 118, diastolicBloodPressure: 72, oxygenSaturation: 96 },
    }),
    event({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
      patientId: IDs.ben,
      category: "medication",
      occurredAt: iso(minutesBefore(now, 4 * 60)),
      recordedAt: iso(minutesBefore(now, 4 * 60)),
      sourceLabel: "Fictional MAR",
      payload: {
        medicationName: "Oxycodone",
        dose: "5 mg",
        route: "oral",
        scheduleType: "prn",
        nextEligibleAt: iso(minutesAfter(now, 15)),
        status: "active",
      },
    }),
    event({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
      patientId: IDs.ben,
      category: "task",
      occurredAt: iso(minutesBefore(now, 40)),
      recordedAt: iso(minutesBefore(now, 40)),
      sourceLabel: "Fictional care task list",
      payload: { title: "Document intake and output", status: "open" },
    }),
    event({
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      patientId: IDs.clara,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 7 * 60)),
      recordedAt: iso(minutesBefore(now, 6 * 60)),
      sourceLabel: "Fictional vital-sign record",
      payload: { heartRate: 84, systolicBloodPressure: 116, diastolicBloodPressure: 70, oxygenSaturation: 98 },
    }),
    event({
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
      patientId: IDs.clara,
      category: "incident",
      occurredAt: iso(minutesBefore(now, 90)),
      recordedAt: iso(minutesBefore(now, 85)),
      sourceLabel: "Fictional incident record",
      payload: { description: "Near-fall reported during transfer; provider notified in scenario.", resolved: false },
    }),
  ];

  if (includeMessy) {
    const david = createDavidRossData(now);
    patients.push(david.patient);
    vitalMonitoringPlans.push(david.plan);
    chartEvents.push(...david.events);
  }

  return { now, patients, chartEvents, vitalMonitoringPlans, nurses };
}

function createDavidRossData(now: Date): {
  patient: Patient;
  plan: VitalMonitoringPlan;
  events: ChartEvent[];
} {
  const patient: Patient = {
    id: IDs.david,
    unitId: IDs.unit,
    isSynthetic: true,
    displayName: "David Ross (fictional)",
    room: "404-B",
    assignedNurseId: IDs.nurse,
    admittedAt: iso(minutesBefore(now, 36 * 60)),
  };

  const plan: VitalMonitoringPlan = {
    id: "77777777-7777-4777-8777-777777777777",
    patientId: IDs.david,
    vitalType: "blood_pressure",
    intervalMinutes: 60,
    attentionBelow: 100,
    urgentBelow: 90,
  };

  const event = <T extends ChartEvent>(value: T): T => value;
  const events: ChartEvent[] = [
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      patientId: IDs.david,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 12 * 60)),
      recordedAt: iso(minutesBefore(now, 12 * 60)),
      sourceLabel: "Fictional shift handover note",
      payload: { summary: "Handover recvd from night. Pt post-op day 1 general surgery, IV cannula L forearm." },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
      patientId: IDs.david,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 11 * 60)),
      recordedAt: iso(minutesBefore(now, 11 * 60)),
      sourceLabel: "Fictional vital-sign record",
      payload: { systolicBloodPressure: 122, diastolicBloodPressure: 78, heartRate: 84 },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
      patientId: IDs.david,
      category: "task",
      occurredAt: iso(minutesBefore(now, 10 * 60)),
      recordedAt: iso(minutesBefore(now, 10 * 60)),
      sourceLabel: "Fictional care task list",
      payload: { title: "Change IV cannula L forearm", dueAt: iso(minutesBefore(now, 7 * 60)), status: "open" },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
      patientId: IDs.david,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 9 * 60 + 45)),
      recordedAt: iso(minutesBefore(now, 9 * 60 + 45)),
      sourceLabel: "Fictional vital-sign record",
      payload: { systolicBloodPressure: 118, diastolicBloodPressure: 74 },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd5",
      patientId: IDs.david,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 9 * 60)),
      recordedAt: iso(minutesBefore(now, 9 * 60)),
      sourceLabel: "Fictional nursing progress note",
      payload: { summary: "Pt c/o mild SOB on walking to bathroom, sats 96% room air." },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd6",
      patientId: IDs.david,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 8 * 60)),
      recordedAt: iso(minutesBefore(now, 8 * 60)),
      sourceLabel: "Fictional vital-sign record",
      payload: { systolicBloodPressure: 110, diastolicBloodPressure: 70, heartRate: 88 },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd7",
      patientId: IDs.david,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 7 * 60 + 30)),
      recordedAt: iso(minutesBefore(now, 7 * 60 + 30)),
      sourceLabel: "Fictional point-of-care test",
      payload: { bloodGlucose: 128 },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd8",
      patientId: IDs.david,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 7 * 60)),
      recordedAt: iso(minutesBefore(now, 7 * 60)),
      sourceLabel: "Fictional nursing progress note",
      payload: { summary: "Cannula NOT changed yet; busy with urgent observations on unit." },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd9",
      patientId: IDs.david,
      category: "medication",
      occurredAt: iso(minutesBefore(now, 6 * 60)),
      recordedAt: iso(minutesBefore(now, 6 * 60)),
      sourceLabel: "Fictional MAR",
      payload: { medicationName: "Paracetamol", dose: "1g", route: "oral", scheduleType: "scheduled", status: "administered" },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd10",
      patientId: IDs.david,
      category: "medication",
      occurredAt: iso(minutesBefore(now, 5 * 60)),
      recordedAt: iso(minutesBefore(now, 5 * 60)),
      sourceLabel: "Fictional MAR",
      payload: { medicationName: "Metoprolol", dose: "25mg", route: "oral", scheduleType: "scheduled", dueAt: iso(minutesBefore(now, 5 * 60)), status: "held" },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd11",
      patientId: IDs.david,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 4 * 60 + 30)),
      recordedAt: iso(minutesBefore(now, 4 * 60 + 30)),
      sourceLabel: "Fictional nursing progress note",
      payload: { summary: "Family visiting, inquired about discharge timing and home wound care." },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd12",
      patientId: IDs.david,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 4 * 60)),
      recordedAt: iso(minutesBefore(now, 4 * 60)),
      sourceLabel: "Fictional vital-sign record",
      payload: { systolicBloodPressure: 98, diastolicBloodPressure: 60, heartRate: 96 },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd13",
      patientId: IDs.david,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 3 * 60 + 30)),
      recordedAt: iso(minutesBefore(now, 3 * 60 + 30)),
      sourceLabel: "Fictional nursing progress note",
      payload: { summary: "Pt walked to bathroom with 1-person assist, saturations stable." },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd14",
      patientId: IDs.david,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 3 * 60)),
      recordedAt: iso(minutesBefore(now, 3 * 60)),
      sourceLabel: "Fictional vital-sign record",
      payload: { systolicBloodPressure: 88, diastolicBloodPressure: 54, heartRate: 100 },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd15",
      patientId: IDs.david,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 2 * 60 + 50)),
      recordedAt: iso(minutesBefore(now, 2 * 60 + 50)),
      sourceLabel: "Fictional provider communication",
      payload: { summary: "Dr. Chen paged regarding hypotensive episode (BP 88/54); planned bedside review at 18:00." },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd16",
      patientId: IDs.david,
      category: "medication",
      occurredAt: iso(minutesBefore(now, 2 * 60 + 20)),
      recordedAt: iso(minutesBefore(now, 2 * 60 + 20)),
      sourceLabel: "Fictional MAR",
      payload: { medicationName: "0.9% Normal Saline Bolus", dose: "500 mL", route: "intravenous", scheduleType: "scheduled", dueAt: iso(minutesBefore(now, 2 * 60 + 20)), status: "active" },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd17",
      patientId: IDs.david,
      category: "task",
      occurredAt: iso(minutesBefore(now, 2 * 60)),
      recordedAt: iso(minutesBefore(now, 2 * 60)),
      sourceLabel: "Fictional care task list",
      payload: { title: "Recheck BP before 17:00", dueAt: iso(minutesBefore(now, 2 * 60)), status: "completed" },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd18",
      patientId: IDs.david,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 1 * 60 + 45)),
      recordedAt: iso(minutesBefore(now, 1 * 60 + 45)),
      sourceLabel: "Fictional nursing progress note",
      payload: { summary: "BP recheck completed; HR 102 bpm, patient resting in bed." },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd19",
      patientId: IDs.david,
      category: "nursing_note",
      occurredAt: iso(minutesBefore(now, 60)),
      recordedAt: iso(minutesBefore(now, 60)),
      sourceLabel: "Fictional provider note",
      payload: { summary: "Dr. Chen reviewed patient at bedside; awaiting documented post-review orders." },
    }),
    event({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddd20",
      patientId: IDs.david,
      category: "vital",
      occurredAt: iso(minutesBefore(now, 15)),
      recordedAt: iso(minutesBefore(now, 15)),
      sourceLabel: "Fictional vital-sign record",
      payload: { systolicBloodPressure: 101, diastolicBloodPressure: 64, heartRate: 98, oxygenSaturation: 97 },
    }),
  ];

  return { patient, plan, events };
}
