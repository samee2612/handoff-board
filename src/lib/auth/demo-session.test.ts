import { describe, expect, it } from "vitest";
import { createDemoSessionToken, parseDemoSessionToken } from "@/lib/auth/demo-session-token";

describe("controlled demo session", () => {
  const secret = "fictional-test-secret";
  const session = { nurseId: "22222222-2222-4222-8222-222222222222", expiresAt: 2_000_000_000_000 };

  it("accepts a signed, unexpired fictional nurse identity", () => {
    const token = createDemoSessionToken(session, secret);
    expect(parseDemoSessionToken(token, secret, 1_000_000_000_000)).toEqual(session);
  });

  it("rejects altered and expired identities", () => {
    const token = createDemoSessionToken(session, secret);
    expect(parseDemoSessionToken(`${token}x`, secret, 1_000_000_000_000)).toBeNull();
    expect(parseDemoSessionToken(token, secret, session.expiresAt)).toBeNull();
  });
});
