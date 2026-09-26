import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const sessionPayloadSchema = z.object({ nurseId: z.string().uuid(), expiresAt: z.number().int().positive() }).strict();
export type DemoSession = z.infer<typeof sessionPayloadSchema>;

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createDemoSessionToken(session: DemoSession, secret: string): string {
  const payload = base64Url(JSON.stringify(sessionPayloadSchema.parse(session)));
  return `${payload}.${signature(payload, secret)}`;
}

export function parseDemoSessionToken(token: string | undefined, secret: string, now = Date.now()): DemoSession | null {
  if (!token) return null;
  const [payload, suppliedSignature, ...rest] = token.split(".");
  if (!payload || !suppliedSignature || rest.length > 0) return null;
  const expectedSignature = signature(payload, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const decoded = decodeBase64Url(payload);
  if (!decoded) return null;
  let decodedValue: unknown;
  try {
    decodedValue = JSON.parse(decoded);
  } catch {
    return null;
  }
  const parsed = sessionPayloadSchema.safeParse(decodedValue);
  return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
}
