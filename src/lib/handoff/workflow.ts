import "server-only";
import { z } from "zod";
import type { HandoffPublication, HandoffReview } from "@/lib/contracts";
import { handoffPublicationSchema, handoffReviewActionSchema, handoffReviewSchema } from "@/lib/contracts";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

export const handoffReviewRequestSchema = z.object({
  handoffVersionId: z.string().uuid(),
  action: handoffReviewActionSchema,
  note: z.string().trim().max(2_000).optional().default(""),
}).strict();

export const publishHandoffRequestSchema = z.object({
  handoffVersionId: z.string().uuid(),
  note: z.string().trim().max(2_000).optional().default(""),
}).strict();

export class HandoffWorkflowError extends Error {
  constructor(readonly code: "SETUP_REQUIRED" | "INVALID_ACTION" | "PERSISTENCE_FAILED", message: string) {
    super(message);
  }
}

function reviewFromRpc(value: unknown): HandoffReview {
  const row = value as Record<string, unknown>;
  return handoffReviewSchema.parse({
    id: row.review_id,
    handoffVersionId: row.handoff_version_id,
    nurseId: row.nurse_id,
    nurseName: row.nurse_name,
    action: row.action,
    note: row.note,
    reviewedAt: row.reviewed_at,
  });
}

function publicationFromRpc(value: unknown): HandoffPublication {
  const row = value as Record<string, unknown>;
  return handoffPublicationSchema.parse({
    id: row.publication_id,
    patientId: row.patient_id,
    handoffVersionId: row.handoff_version_id,
    publishedByNurseId: row.published_by_nurse_id,
    note: row.note,
    publishedAt: row.published_at,
  });
}

export async function recordHandoffReview(input: z.infer<typeof handoffReviewRequestSchema>, nurseId: string): Promise<HandoffReview> {
  const client = createOptionalSupabaseServiceClient();
  if (!client) throw new HandoffWorkflowError("SETUP_REQUIRED", "Connect Supabase before saving shared reviews.");
  const { data, error } = await client.rpc("record_handoff_review", {
    p_handoff_version_id: input.handoffVersionId,
    p_nurse_id: nurseId,
    p_action: input.action,
    p_note: input.note,
  }).single();
  if (error || !data) {
    throw new HandoffWorkflowError("INVALID_ACTION", error?.message || "The review could not be saved.");
  }
  return reviewFromRpc(data);
}

export async function publishCandidateHandoff(input: z.infer<typeof publishHandoffRequestSchema>, nurseId: string): Promise<HandoffPublication> {
  const client = createOptionalSupabaseServiceClient();
  if (!client) throw new HandoffWorkflowError("SETUP_REQUIRED", "Connect Supabase before publishing a shared handoff.");
  const { data, error } = await client.rpc("publish_candidate_handoff", {
    p_handoff_version_id: input.handoffVersionId,
    p_nurse_id: nurseId,
    p_note: input.note,
  }).single();
  if (error || !data) {
    throw new HandoffWorkflowError("INVALID_ACTION", error?.message || "The candidate could not be published.");
  }
  return publicationFromRpc(data);
}
