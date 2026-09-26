import { describe, expect, it } from "vitest";
import { getSupabaseConfiguration } from "@/lib/supabase/client";

describe("getSupabaseConfiguration", () => {
  it("requires both public values before enabling the optional client", () => {
    expect(getSupabaseConfiguration({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" })).toBeNull();
    expect(
      getSupabaseConfiguration({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon-key",
      }),
    ).toEqual({ url: "https://example.supabase.co", anonKey: "public-anon-key" });
  });
});
