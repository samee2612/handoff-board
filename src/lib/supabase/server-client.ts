import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceConfiguration } from "@/lib/supabase/server-config";

/** The service key is server-only and is used solely for synthetic-demo server data access. */
export function createOptionalSupabaseServiceClient(): SupabaseClient | null {
  const config = getSupabaseServiceConfiguration();
  return config
    ? createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
}
