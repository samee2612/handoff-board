import { describe, expect, it } from "vitest";
import { getSupabaseConfiguration } from "@/lib/supabase/client";
import { getSupabaseServiceConfiguration } from "@/lib/supabase/server-config";

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

describe("getSupabaseServiceConfiguration", () => {
  it("requires a server-only service key in addition to the public connection values", () => {
    expect(getSupabaseServiceConfiguration({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon-key",
    })).toBeNull();
    expect(getSupabaseServiceConfiguration({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
    })).toEqual({ url: "https://example.supabase.co", anonKey: "public-anon-key", serviceRoleKey: "server-only-key" });
  });
});
