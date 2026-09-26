import "server-only";
import { cookies } from "next/headers";
import { createDemoSessionToken, parseDemoSessionToken, type DemoSession } from "@/lib/auth/demo-session-token";

const SESSION_COOKIE = "handoff_demo_session";
export type { DemoSession } from "@/lib/auth/demo-session-token";
export { createDemoSessionToken, parseDemoSessionToken } from "@/lib/auth/demo-session-token";

function sessionSecret(): string | null {
  return process.env.DEMO_SESSION_SECRET ?? null;
}

export async function readDemoSession(): Promise<DemoSession | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  const cookieStore = await cookies();
  return parseDemoSessionToken(cookieStore.get(SESSION_COOKIE)?.value, secret);
}

export async function writeDemoSession(nurseId: string): Promise<boolean> {
  const secret = sessionSecret();
  if (!secret) return false;
  const session = { nurseId, expiresAt: Date.now() + 12 * 60 * 60 * 1_000 };
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, createDemoSessionToken(session, secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return true;
}

export async function clearDemoSession() {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}
