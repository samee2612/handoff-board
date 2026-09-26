import { describe, expect, it } from "vitest";
import { chartEventSchema, patientSchema } from "@/lib/contracts";
import { createDemoUnit } from "@/lib/demo/seed-data";

describe("foundation contracts", () => {
  it("validates every fictional seed record at the runtime boundary", () => {
    const unit = createDemoUnit();

    expect(unit.patients.map((patient) => patientSchema.safeParse(patient).success)).not.toContain(false);
    expect(unit.chartEvents.map((event) => chartEventSchema.safeParse(event).success)).not.toContain(false);
  });
});
