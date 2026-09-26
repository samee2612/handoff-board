import { NextResponse } from "next/server";
import { readDemoSession } from "@/lib/auth/demo-session";
import { assertSyntheticOnlyDeployment, UnsafeDeploymentConfigurationError } from "@/lib/config/deployment";
import { HandoffWorkflowError, handoffReviewRequestSchema, recordHandoffReview } from "@/lib/handoff/workflow";

export async function POST(request: Request) {
  try {
    assertSyntheticOnlyDeployment();
  } catch (error) {
    if (error instanceof UnsafeDeploymentConfigurationError) {
      return NextResponse.json({ error: "This hosted demo is not configured for synthetic-only operation." }, { status: 503 });
    }
    throw error;
  }
  const session = await readDemoSession();
  if (!session) return NextResponse.json({ error: "Choose a reviewing nurse before saving a review." }, { status: 401 });
  const parsed = handoffReviewRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Review details are invalid." }, { status: 400 });
  try {
    return NextResponse.json(await recordHandoffReview(parsed.data, session.nurseId));
  } catch (error) {
    if (error instanceof HandoffWorkflowError) {
      return NextResponse.json({ error: error.message }, { status: error.code === "SETUP_REQUIRED" ? 503 : 409 });
    }
    return NextResponse.json({ error: "The review could not be saved." }, { status: 500 });
  }
}
