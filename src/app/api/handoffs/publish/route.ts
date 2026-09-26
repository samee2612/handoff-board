import { NextResponse } from "next/server";
import { readDemoSession } from "@/lib/auth/demo-session";
import { assertSyntheticOnlyDeployment, UnsafeDeploymentConfigurationError } from "@/lib/config/deployment";
import { HandoffWorkflowError, publishCandidateHandoff, publishHandoffRequestSchema } from "@/lib/handoff/workflow";

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
  if (!session) return NextResponse.json({ error: "Choose a reviewing nurse before publishing." }, { status: 401 });
  const parsed = publishHandoffRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Publication details are invalid." }, { status: 400 });
  try {
    return NextResponse.json(await publishCandidateHandoff(parsed.data, session.nurseId));
  } catch (error) {
    if (error instanceof HandoffWorkflowError) {
      return NextResponse.json({ error: error.message }, { status: error.code === "SETUP_REQUIRED" ? 503 : 409 });
    }
    return NextResponse.json({ error: "The candidate could not be published." }, { status: 500 });
  }
}
