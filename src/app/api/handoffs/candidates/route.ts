import { NextResponse } from "next/server";
import { readDemoSession } from "@/lib/auth/demo-session";
import { assertSyntheticOnlyDeployment, UnsafeDeploymentConfigurationError } from "@/lib/config/deployment";
import { CandidateRefreshError, candidateRefreshRequestSchema, createCandidateVersion } from "@/lib/handoff/candidates";

export async function POST(request: Request) {
  try {
    assertSyntheticOnlyDeployment();
  } catch (error) {
    if (error instanceof UnsafeDeploymentConfigurationError) {
      return NextResponse.json({ error: "This hosted demo is not configured for synthetic-only operation." }, { status: 503 });
    }
    throw error;
  }
  const parsed = candidateRefreshRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid synthetic patient ID is required." }, { status: 400 });
  if (!await readDemoSession()) return NextResponse.json({ error: "Choose a reviewing nurse before creating a candidate." }, { status: 401 });
  try {
    const candidate = await createCandidateVersion(parsed.data.patientId);
    return NextResponse.json(candidate);
  } catch (error) {
    if (error instanceof CandidateRefreshError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "SETUP_REQUIRED" ? 503 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "Candidate generation failed. The previous handoff remains unchanged." }, { status: 500 });
  }
}
