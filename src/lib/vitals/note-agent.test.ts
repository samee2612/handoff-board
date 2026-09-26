import { describe, expect, it } from "vitest";
import { extractVitalFromNote, VitalNoteExtractionError } from "@/lib/vitals/note-agent";

describe("extractVitalFromNote", () => {
  const now = new Date("2026-09-26T19:00:00.000Z");

  it("extracts a messy BP update and its supplied time", () => {
    const expectedTime = new Date(now);
    expectedTime.setHours(16, 0, 0, 0);
    expect(extractVitalFromNote("BP done, 118/72 at 4 pm", now)).toEqual({
      vitalType: "blood_pressure",
      value: 118,
      diastolicValue: 72,
      recordedAt: expectedTime.toISOString(),
    });
  });

  it("extracts supported single-value vitals", () => {
    expect(extractVitalFromNote("SpO2 was 97% at 16:20", now)).toMatchObject({ vitalType: "oxygen_saturation", value: 97 });
    expect(extractVitalFromNote("blood sugar 120", now)).toMatchObject({ vitalType: "blood_glucose", value: 120 });
  });

  it("rejects a note without an explicit supported measurement", () => {
    expect(() => extractVitalFromNote("Patient appears comfortable", now)).toThrow(VitalNoteExtractionError);
  });
});
