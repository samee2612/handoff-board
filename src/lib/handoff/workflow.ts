import "server-only";
import { z } from "zod";
import type { HandoffPublication, HandoffReview } from "@/lib/contracts";
import { handoffReviewSchema } from "@/lib/contracts";
import { getHandoffCheckpointer } from "@/lib/handoff/checkpointer";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { SupabaseHandoffDataLayer } from "@/lib/handoff/supabase-data-layer";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

export const handoffReviewRequestSchema = z.object({
  handoffVersionId: z.string().uuid(),
  action: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(2_000).optional().default(""),
}).strict().superRefine((value, context) => {
  if (value.action === "rejected" && value.note.length === 0) {
    context.addIssue({ code: "custom", path: ["note"], message: "A rejection note is required." });
  }
});

export class HandoffWorkflowError extends Error {
  constructor(
    readonly code: "SETUP_REQUIRED" | "INVALID_ACTION" | "PERSISTENCE_FAILED" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

function reviewFromRpc(value: unknown): HandoffReview {
  const row = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
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

async function recordHandoffReview(
  input: z.infer<typeof handoffReviewRequestSchema>,
  nurseId: string,
  client: NonNullable<ReturnType<typeof createOptionalSupabaseServiceClient>>,
): Promise<HandoffReview> {
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

export async function resumeHandoffReview(
  input: z.infer<typeof handoffReviewRequestSchema>,
  nurseId: string,
): Promise<{ review: HandoffReview; publication: HandoffPublication | null; status: "published" | "rejected" }> {
  const client = createOptionalSupabaseServiceClient();
  if (!client) {
    throw new HandoffWorkflowError("SETUP_REQUIRED", "Connect Supabase before reviewing a shared handoff.");
  }

  const data = new SupabaseHandoffDataLayer(client);
  const version = await data.get(input.handoffVersionId);
  if (!version || version.status !== "candidate") {
    throw new HandoffWorkflowError("NOT_FOUND", "The requested candidate handoff was not found.");
  }
  const threadId = await data.getReviewThreadId(version.id);
  if (!threadId) {
    throw new HandoffWorkflowError("NOT_FOUND", "The candidate has no resumable review checkpoint.");
  }

  let checkpointer;
  try {
    checkpointer = await getHandoffCheckpointer();
  } catch (error) {
    throw new HandoffWorkflowError(
      "SETUP_REQUIRED",
      error instanceof Error ? error.message : "Persistent graph checkpointing is not configured.",
    );
  }

  const review = await recordHandoffReview(input, nurseId, client);
  const pipeline = new HandoffPipeline({ data, checkpointer });
  let state;
  try {
    state = await pipeline.resume(threadId, input.action);
  } catch (error) {
    throw new HandoffWorkflowError(
      "PERSISTENCE_FAILED",
      error instanceof Error ? error.message : "The review checkpoint could not be resumed.",
    );
  }

  if (input.action === "rejected") {
    if (state.status !== "rejected") {
      throw new HandoffWorkflowError("PERSISTENCE_FAILED", "The graph did not finish the rejected review.");
    }
    return { review, publication: null, status: "rejected" };
  }

  if (state.status !== "published") {
    throw new HandoffWorkflowError("PERSISTENCE_FAILED", "The approved graph did not append a publication.");
  }
  const publication = (await data.listPublications(version.patientId))
    .find((item) => item.handoffVersionId === version.id) ?? null;
  if (!publication) {
    throw new HandoffWorkflowError("PERSISTENCE_FAILED", "The graph reported publication without a publication record.");
  }
  return { review, publication, status: "published" };
}
