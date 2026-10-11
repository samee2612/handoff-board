import { describe, expect, it, vi } from "vitest";
import { loadEnvConfig } from "@next/env";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { InMemoryHandoffDataLayer, type HandoffDataLayer } from "@/lib/handoff/data-layer";
import { SupabaseHandoffDataLayer } from "@/lib/handoff/supabase-data-layer";
import { createOptionalSupabaseServiceClient } from "@/lib/supabase/server-client";

vi.mock("server-only", () => ({}));
loadEnvConfig(process.cwd());

const demo = createDemoUnit();
const patientId = demo.patients[0].id;
const triggerEventId = demo.chartEvents.find(
  (event) => event.patientId === patientId && event.category === "vital",
)!.id;

type ContractDataLayer = Pick<HandoffDataLayer, "getPatient" | "getEvents" | "getPlan" | "get">;
const implementations: Array<{ name: string; create: () => ContractDataLayer }> = [
  {
    name: "in-memory",
    create: () => new InMemoryHandoffDataLayer(),
  },
];

const supabase = createOptionalSupabaseServiceClient();
if (supabase) {
  implementations.push({
    name: "Supabase",
    create: () => new SupabaseHandoffDataLayer(supabase),
  });
}

describe.each(implementations)("$name handoff data-layer contract", ({ create }) => {
  it("loads a synthetic patient and contract-valid chart events", async () => {
    const data = create();
    const patient = await data.getPatient(patientId);
    const events = await data.getEvents(patientId);

    expect(patient?.isSynthetic).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.patientId === patientId)).toBe(true);
  });

  it("loads a monitoring plan for the trigger event", async () => {
    const data = create();
    const plan = await data.getPlan(patientId, triggerEventId);

    expect(plan?.patientId).toBe(patientId);
  });

  it("returns null for unknown versions", async () => {
    expect(await create().get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  describe("fixture protocol retrieval", () => {
    it("returns at most three fixed protocol chunks without external services", async () => {
      const data = new InMemoryHandoffDataLayer();

      expect(await data.retrieve("synthetic handoff context", 10)).toHaveLength(3);
      expect(await data.retrieve("synthetic handoff context", 0)).toEqual([]);
    });
  });
});

describe.skipIf(!supabase)("optional Supabase integration", () => {
  it("connects to the seeded synthetic test patient", async () => {
    const patient = await new SupabaseHandoffDataLayer(supabase!).getPatient(patientId);

    expect(patient?.isSynthetic).toBe(true);
  });
});
