import { NextResponse } from "next/server";
import { readDemoSession } from "@/lib/auth/demo-session";
import { assertSyntheticOnlyDeployment, UnsafeDeploymentConfigurationError } from "@/lib/config/deployment";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";
import { recordSyntheticVitalComment, VitalRecordingError, vitalCommentRequestSchema } from "@/lib/vitals/recording";
import { VitalNoteExtractionError } from "@/lib/vitals/note-agent";

export async function POST(request: Request) {
  try {
    assertSyntheticOnlyDeployment();
  } catch (error) {
    if (error instanceof UnsafeDeploymentConfigurationError) return NextResponse.json({ error: "This hosted demo is not configured for synthetic-only operation." }, { status: 503 });
    throw error;
  }
  if (createOptionalSupabaseServiceClient() && !await readDemoSession()) return NextResponse.json({ error: "Choose a fictional nurse before recording a shared vital." }, { status: 401 });
  const parsed = vitalCommentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Write a supported synthetic vital update." }, { status: 400 });
  try {
    return NextResponse.json(await recordSyntheticVitalComment(parsed.data.patientId, parsed.data.note));
  } catch (error) {
    if (error instanceof VitalNoteExtractionError) return NextResponse.json({ error: error.message }, { status: 422 });
    if (error instanceof VitalRecordingError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "SETUP_REQUIRED" ? 503 : 422;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "The synthetic vital could not be recorded." }, { status: 500 });
  }
}
