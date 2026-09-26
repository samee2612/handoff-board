import { z } from "zod";

export const isoDateTime = z.string().datetime({ offset: true });

export const chartEventCategorySchema = z.enum([
  "nursing_note",
  "vital",
  "medication",
  "task",
  "incident",
]);

export type ChartEventCategory = z.infer<typeof chartEventCategorySchema>;

export const patientSchema = z.object({
  id: z.string().uuid(),
  unitId: z.string().uuid(),
  displayName: z.string().min(1),
  room: z.string().min(1),
  assignedNurseId: z.string().uuid(),
  admittedAt: isoDateTime,
});

export type Patient = z.infer<typeof patientSchema>;

const eventBaseSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  occurredAt: isoDateTime,
  recordedAt: isoDateTime,
  sourceLabel: z.string().min(1),
});

export const nursingNoteEventSchema = eventBaseSchema.extend({
  category: z.literal("nursing_note"),
  payload: z.object({ summary: z.string().min(1) }),
});

export const vitalEventSchema = eventBaseSchema.extend({
  category: z.literal("vital"),
  payload: z.object({
    heartRate: z.number().positive().optional(),
    systolicBloodPressure: z.number().positive().optional(),
    diastolicBloodPressure: z.number().positive().optional(),
    temperatureCelsius: z.number().positive().optional(),
    oxygenSaturation: z.number().min(0).max(100).optional(),
  }),
});

export const medicationEventSchema = eventBaseSchema.extend({
  category: z.literal("medication"),
  payload: z.object({
    medicationName: z.string().min(1),
    dose: z.string().min(1),
    route: z.string().min(1),
    scheduleType: z.enum(["scheduled", "prn"]),
    dueAt: isoDateTime.optional(),
    nextEligibleAt: isoDateTime.optional(),
    status: z.enum(["active", "administered", "held", "discontinued"]),
  }),
});

export const taskEventSchema = eventBaseSchema.extend({
  category: z.literal("task"),
  payload: z.object({
    title: z.string().min(1),
    dueAt: isoDateTime.optional(),
    status: z.enum(["open", "completed", "cancelled"]),
  }),
});

export const incidentEventSchema = eventBaseSchema.extend({
  category: z.literal("incident"),
  payload: z.object({ description: z.string().min(1), resolved: z.boolean() }),
});

export const chartEventSchema = z.discriminatedUnion("category", [
  nursingNoteEventSchema,
  vitalEventSchema,
  medicationEventSchema,
  taskEventSchema,
  incidentEventSchema,
]);

export type ChartEvent = z.infer<typeof chartEventSchema>;

export const alertSchema = z.object({
  id: z.string(),
  patientId: z.string().uuid(),
  eventId: z.string().uuid(),
  kind: z.enum(["scheduled_medication", "eligible_prn", "task"]),
  priority: z.enum(["overdue", "imminent"]),
  dueAt: isoDateTime,
  title: z.string(),
  sourceLabel: z.string(),
});

export type ActionAlert = z.infer<typeof alertSchema>;

export const freshnessStatusSchema = z.enum(["green", "amber", "red"]);
export type FreshnessStatus = z.infer<typeof freshnessStatusSchema>;

export type FreshnessEvaluation = {
  status: FreshnessStatus;
  missingCategories: ChartEventCategory[];
  staleCategories: ChartEventCategory[];
  evaluatedAt: string;
};
