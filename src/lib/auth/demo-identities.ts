import "server-only";
import { z } from "zod";
import { createDemoUnit, type DemoNurse } from "@/lib/demo/seed-data";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

const nurseIdSchema = z.string().uuid();

/**
 * This is deliberately a controlled synthetic identity selector, not clinical authentication.
 * A production SSO/OIDC integration replaces this module before real-data use is considered.
 */
export async function findControlledDemoNurse(value: unknown): Promise<DemoNurse | null> {
  const parsed = nurseIdSchema.safeParse(value);
  if (!parsed.success) return null;
  const client = createOptionalSupabaseServiceClient();
  if (!client) return createDemoUnit().nurses.find((nurse) => nurse.id === parsed.data) ?? null;

  const { data: nurse, error: nurseError } = await client
    .from("nurses")
    .select("id, display_name, unit_id")
    .eq("id", parsed.data)
    .maybeSingle();
  if (nurseError || !nurse) return null;
  const { data: syntheticPatient, error: patientError } = await client
    .from("patients")
    .select("id")
    .eq("unit_id", nurse.unit_id)
    .eq("is_synthetic", true)
    .limit(1)
    .maybeSingle();
  if (patientError || !syntheticPatient) return null;
  return { id: nurse.id, displayName: nurse.display_name };
}
