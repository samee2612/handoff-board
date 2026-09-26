import type { VitalType } from "@/lib/contracts";

export type ParsedVitalNote = {
  vitalType: VitalType;
  value: number;
  diastolicValue?: number;
  recordedAt: string;
};

export class VitalNoteExtractionError extends Error {}

function recordedTime(note: string, now: Date): string {
  const match = note.match(/(?:\bat\b|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?(?:m\.?)?|p\.?(?:m\.?)?)?\b/i);
  if (!match) return now.toISOString();
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const suffix = match[3]?.replaceAll(".", "").toLowerCase();
  if (hour > 23 || minute > 59) return now.toISOString();
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  const value = new Date(now);
  // The synthetic demo interprets a nurse's written time in the local unit timezone.
  // A production integration should receive the unit timezone explicitly from the EHR context.
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
}

/**
 * The synthetic note-extraction agent accepts a deliberately small, auditable grammar.
 * It never guesses a missing measurement; unsupported or ambiguous text is rejected.
 */
export function extractVitalFromNote(note: string, now = new Date()): ParsedVitalNote {
  const text = note.trim().toLowerCase();
  const timestamp = recordedTime(text, now);
  const bloodPressure = text.match(/(?:\bbp\b|blood pressure)[^\d]*(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})/i);
  if (bloodPressure) return { vitalType: "blood_pressure", value: Number(bloodPressure[1]), diastolicValue: Number(bloodPressure[2]), recordedAt: timestamp };

  const oxygen = text.match(/(?:\bspo2\b|\bo2\s*(?:sat|saturation)?\b|oxygen saturation)[^\d]*(\d{2,3})\s*%?/i);
  if (oxygen) return { vitalType: "oxygen_saturation", value: Number(oxygen[1]), recordedAt: timestamp };

  const glucose = text.match(/(?:blood\s*(?:sugar|glucose)|\bglucose\b|\bbgl\b)[^\d]*(\d{2,3}(?:\.\d+)?)/i);
  if (glucose) return { vitalType: "blood_glucose", value: Number(glucose[1]), recordedAt: timestamp };

  const temperature = text.match(/(?:\btemperature\b|\btemp\b)[^\d]*(\d{2}(?:\.\d+)?)/i);
  if (temperature) return { vitalType: "temperature", value: Number(temperature[1]), recordedAt: timestamp };

  const heartRate = text.match(/(?:heart rate|\bhr\b|\bpulse\b)[^\d]*(\d{2,3})/i);
  if (heartRate) return { vitalType: "heart_rate", value: Number(heartRate[1]), recordedAt: timestamp };

  throw new VitalNoteExtractionError("I could not identify a supported vital. Try “BP 118/72 at 4 pm” or “SpO2 97% at 4 pm”.");
}
