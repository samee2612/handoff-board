import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SupabaseConfiguration = {
  url: string;
  anonKey: string;
};

export type SupabasePublicEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
};

export function getSupabaseConfiguration(
  environment: SupabasePublicEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
): SupabaseConfiguration | null {
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey } = environment;
  return url && anonKey ? { url, anonKey } : null;
}

/** Returns null for the local fixture mode, keeping the synthetic demo usable before setup. */
export function createOptionalSupabaseClient(): SupabaseClient | null {
  const config = getSupabaseConfiguration();
  return config ? createClient(config.url, config.anonKey) : null;
}
