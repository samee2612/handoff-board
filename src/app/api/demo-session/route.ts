import { NextResponse } from "next/server";
import { clearDemoSession, readDemoSession, writeDemoSession } from "@/lib/auth/demo-session";
import { findControlledDemoNurse } from "@/lib/auth/demo-identities";
import { assertSyntheticOnlyDeployment, UnsafeDeploymentConfigurationError } from "@/lib/config/deployment";

function deploymentError() {
  return NextResponse.json({ error: "This hosted demo is not configured for synthetic-only operation." }, { status: 503 });
}

export async function GET() {
  try {
    assertSyntheticOnlyDeployment();
  } catch (error) {
    if (error instanceof UnsafeDeploymentConfigurationError) return deploymentError();
    throw error;
  }
  const session = await readDemoSession();
  if (!session) return NextResponse.json({ nurseId: null });
  const nurse = await findControlledDemoNurse(session.nurseId);
  return NextResponse.json({ nurseId: nurse?.id ?? null, nurseName: nurse?.displayName ?? null });
}

export async function POST(request: Request) {
  try {
    assertSyntheticOnlyDeployment();
  } catch (error) {
    if (error instanceof UnsafeDeploymentConfigurationError) return deploymentError();
    throw error;
  }
  const body = await request.json().catch(() => null) as { nurseId?: unknown } | null;
  const nurse = await findControlledDemoNurse(body?.nurseId);
  if (!nurse) return NextResponse.json({ error: "Choose a valid fictional nurse." }, { status: 400 });
  if (!await writeDemoSession(nurse.id)) {
    return NextResponse.json({ error: "Set DEMO_SESSION_SECRET before using controlled demo identities." }, { status: 503 });
  }
  return NextResponse.json({ nurseId: nurse.id, nurseName: nurse.displayName });
}

export async function DELETE() {
  await clearDemoSession();
  return new NextResponse(null, { status: 204 });
}
