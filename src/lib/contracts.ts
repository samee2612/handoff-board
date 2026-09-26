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
  isSynthetic: z.literal(true),
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

export const specialistNameSchema = z.enum(["chart_vitals", "medications", "tasks_incidents"]);
export type SpecialistName = z.infer<typeof specialistNameSchema>;

export const extractedFactSchema = z
  .object({
    id: z.string().min(1),
    specialist: specialistNameSchema,
    summary: z.string().min(1),
    evidenceEventIds: z.array(z.string().uuid()).min(1),
  })
  .strict();
export type ExtractedFact = z.infer<typeof extractedFactSchema>;

export const sbarSectionSchema = z.enum(["situation", "background", "assessment", "recommendation"]);
export type SbarSection = z.infer<typeof sbarSectionSchema>;

export const handoffClaimSchema = z
  .object({
    id: z.string().min(1),
    section: sbarSectionSchema,
    text: z.string().min(1),
    evidenceEventIds: z.array(z.string().uuid()).min(1),
  })
  .strict();
export type HandoffClaim = z.infer<typeof handoffClaimSchema>;

export const verificationDecisionSchema = z
  .object({
    claimId: z.string().min(1),
    status: z.enum(["supported", "gap"]),
    reason: z.string().min(1),
  })
  .strict();
export type VerificationDecision = z.infer<typeof verificationDecisionSchema>;

export const agentDiagnosticSchema = z
  .object({
    runId: z.string().uuid(),
    agent: z.enum(["chart_vitals", "medications", "tasks_incidents", "sbar_synthesizer", "evidence_verifier"]),
    status: z.enum(["succeeded", "failed"]),
    model: z.string().min(1),
    startedAt: isoDateTime,
    completedAt: isoDateTime,
    inputEventCount: z.number().int().nonnegative(),
    outputCount: z.number().int().nonnegative(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict();
export type AgentDiagnostic = z.infer<typeof agentDiagnosticSchema>;

export const handoffFailureSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1) })
  .strict();
export type HandoffFailure = z.infer<typeof handoffFailureSchema>;

export const handoffVersionSchema = z
  .object({
    id: z.string().uuid(),
    versionNumber: z.number().int().positive(),
    patientId: z.string().uuid(),
    sourceEventCutoff: isoDateTime,
    generatedAt: isoDateTime,
    model: z.string().min(1),
    status: z.enum(["candidate", "published", "failed"]),
    claims: z.array(handoffClaimSchema),
    excludedClaims: z.array(
      z.object({ claim: handoffClaimSchema, reason: z.string().min(1) }).strict(),
    ),
    diagnostics: z.array(agentDiagnosticSchema),
    failure: handoffFailureSchema.nullable(),
  })
  .strict()
  .superRefine((version, context) => {
    if ((version.status === "published" || version.status === "candidate") && version.failure !== null) {
      context.addIssue({ code: "custom", message: "Non-failed versions cannot contain a failure." });
    }
    if (version.status === "failed" && version.failure === null) {
      context.addIssue({ code: "custom", message: "Failed versions must contain a failure." });
    }
  });
export type HandoffVersion = z.infer<typeof handoffVersionSchema>;
