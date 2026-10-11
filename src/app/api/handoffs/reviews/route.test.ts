import { describe, expect, it, vi } from "vitest";
import { POST as reviewPost } from "@/app/api/handoffs/reviews/route";
import { POST as publishPost } from "@/app/api/handoffs/publish/route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/demo-session", () => ({
  readDemoSession: vi.fn(async () => ({ nurseId: "22222222-2222-4222-8222-222222222222" })),
}));

describe("handoff review routes", () => {
  it("rejects review decisions other than approved or rejected", async () => {
    const response = await reviewPost(new Request("http://localhost/api/handoffs/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handoffVersionId: "33333333-3333-4333-8333-333333333333",
        action: "maybe",
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Review details are invalid." });
  });

  it("refuses publication outside the review route", async () => {
    const response = await publishPost();

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "Publication is only available through an approved handoff review.",
    });
  });
});
