import { NextResponse } from "next/server";
import { CandidateRefreshError, candidateRefreshRequestSchema, createCandidateVersion } from "@/lib/handoff/candidates";

export async function POST(request: Request) {
  const parsed = candidateRefreshRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid synthetic patient ID is required." }, { status: 400 });
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
