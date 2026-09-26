import { getSupabaseConfiguration, type SupabaseConfiguration, type SupabasePublicEnvironment } from "@/lib/supabase/client";

export type SupabaseServiceEnvironment = SupabasePublicEnvironment & { SUPABASE_SERVICE_ROLE_KEY?: string };

/** Kept out of browser-importable modules so the service-role environment variable is never bundled. */
export function getSupabaseServiceConfiguration(
  environment: SupabaseServiceEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
): (SupabaseConfiguration & { serviceRoleKey: string }) | null {
  const publicConfig = getSupabaseConfiguration(environment);
  return publicConfig && environment.SUPABASE_SERVICE_ROLE_KEY
    ? { ...publicConfig, serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY }
    : null;
}
