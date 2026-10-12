import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChartEvent } from "@/lib/contracts";
import { getGeminiModel } from "@/lib/config/model";

export const parsedUpdateSchema = z.object({
  category: z.enum(["vital", "nursing_note", "medication", "task", "incident"]),
  summary: z.string().describe("Concise clinical summary of the note, observation, or instruction"),
  vital: z
    .object({
      systolicBloodPressure: z.number().optional(),
      diastolicBloodPressure: z.number().optional(),
      heartRate: z.number().optional(),
      oxygenSaturation: z.number().optional(),
      temperatureCelsius: z.number().optional(),
      bloodGlucose: z.number().optional(),
    })
    .optional(),
  medication: z
    .object({
      medicationName: z.string(),
      dose: z.string().default("standard dose"),
      route: z.string().default("IV"),
      scheduleType: z.enum(["scheduled", "prn"]).default("scheduled"),
      status: z.enum(["active", "administered", "held", "discontinued"]).default("administered"),
    })
    .optional(),
  task: z
    .object({
      title: z.string(),
      status: z.enum(["open", "completed", "cancelled"]).default("completed"),
    })
    .optional(),
  incident: z
    .object({
      description: z.string(),
      resolved: z.boolean().default(true),
    })
    .optional(),
});

export type ParsedClinicalUpdate = z.infer<typeof parsedUpdateSchema>;

/** Deterministic heuristic parser used when offline or as immediate fallback. */
export function heuristicParseClinicalNote(note: string): ParsedClinicalUpdate {
  const text = note.trim();
  const lower = text.toLowerCase();

  // 1. Vital detection
  const bpMatch = text.match(/(?:\bbp\b|blood pressure)[^\d]*(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})/i);
  const hrMatch = text.match(/(?:\bhr\b|\bpulse\b|heart\s*rate)[^\d]*(\d{2,3})/i);
  const spo2Match = text.match(/(?:\bspo2\b|\bo2\s*(?:sat|saturation)?\b|oxygen)[^\d]*(\d{2,3})\s*%?/i);
  const glucoseMatch = text.match(/(?:blood\s*(?:sugar|glucose)|\bglucose\b|\bbgl\b)[^\d]*(\d{2,3}(?:\.\d+)?)/i);
  const tempMatch = text.match(/(?:\btemperature\b|\btemp\b)[^\d]*(\d{2}(?:\.\d+)?)/i);

  const hasVitals = Boolean(bpMatch || hrMatch || spo2Match || glucoseMatch || tempMatch);
  const vital: ParsedClinicalUpdate["vital"] = hasVitals
    ? {
        systolicBloodPressure: bpMatch ? Number(bpMatch[1]) : undefined,
        diastolicBloodPressure: bpMatch ? Number(bpMatch[2]) : undefined,
        heartRate: hrMatch ? Number(hrMatch[1]) : undefined,
        oxygenSaturation: spo2Match ? Number(spo2Match[1]) : undefined,
        bloodGlucose: glucoseMatch ? Number(glucoseMatch[1]) : undefined,
        temperatureCelsius: tempMatch ? Number(tempMatch[1]) : undefined,
      }
    : undefined;

  // 2. Incident detection
  if (/fall|slipped|tripped|incident|dropped|injury|skin tear/i.test(lower)) {
    return {
      category: "incident",
      summary: text,
      vital,
      incident: {
        description: text,
        resolved: !/unresolved|pending|investigating/i.test(lower),
      },
    };
  }

  // 3. Medication detection
  if (/bolus|saline|infusion|metoprolol|tylenol|acetaminophen|morphine|medication|held|dose|mg|iv push|started iv/i.test(lower)) {
    let status: "active" | "administered" | "held" | "discontinued" = "administered";
    if (/held|hold/i.test(lower)) status = "held";
    else if (/started|running|infusing|active/i.test(lower)) status = "active";
    else if (/discontinued|stopped/i.test(lower)) status = "discontinued";

    return {
      category: "medication",
      summary: text,
      vital,
      medication: {
        medicationName: text.slice(0, 60),
        dose: (text.match(/(\d+\s*(?:mg|ml|g|units|mcg))/i) ?? [])[1] ?? "1 dose",
        route: /oral|po\b/i.test(lower) ? "oral" : "IV",
        scheduleType: /prn|as needed/i.test(lower) ? "prn" : "scheduled",
        status,
      },
    };
  }

  // 4. Task detection
  if (/cannula|dressing|foley|catheter|iv change|ambulate|ambulation|pt consult|wound/i.test(lower)) {
    return {
      category: "task",
      summary: text,
      vital,
      task: {
        title: text,
        status: /pending|open|due/i.test(lower) ? "open" : "completed",
      },
    };
  }

  // 5. Default vital or nursing note
  if (hasVitals && text.length < 35) {
    return {
      category: "vital",
      summary: text,
      vital,
    };
  }

  return {
    category: "nursing_note",
    summary: text,
    vital,
  };
}

/** Parses clinical text into structured EHR fields using Gemini AI with fallback to deterministic heuristic. */
export async function parseClinicalNoteWithAI(note: string): Promise<ParsedClinicalUpdate> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey || process.env.USE_FAKE_LLM === "1") {
    return heuristicParseClinicalNote(note);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = getGeminiModel();

    let jsonSchema: Record<string, unknown> | undefined;
    try {
      const rawSchema = (z as unknown as { toJSONSchema?: (s: z.ZodType<unknown>) => Record<string, unknown> }).toJSONSchema
        ? (z as unknown as { toJSONSchema: (s: z.ZodType<unknown>) => Record<string, unknown> }).toJSONSchema(parsedUpdateSchema)
        : undefined;
      if (rawSchema && typeof rawSchema === "object") {
        jsonSchema = { ...rawSchema };
        delete jsonSchema["$schema"];
      }
    } catch {
      jsonSchema = undefined;
    }

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `You are an expert Clinical Informatics EHR Assistant. A nurse has typed a bedside clinical update or chart patch:
"${note}"

Categorize this update into one of:
- "vital": if primarily reporting vital sign numbers (BP, HR, SpO2, temp, glucose).
- "medication": if administering, holding, starting, or modifying medication or IV infusions.
- "task": if documenting a completed, open, or cancelled nursing task, dressing, or ambulation.
- "incident": if reporting a patient fall, incident, or adverse event.
- "nursing_note": if documenting general patient condition, physician callbacks, symptom changes, or bedside assessments.

If any vital sign measurements are present anywhere in the text, extract them into the "vital" object.
Respond ONLY with valid JSON.`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        ...(jsonSchema ? { responseSchema: jsonSchema } : {}),
      },
    });

    const text = response.text?.trim() ?? "";
    const parsedJson = JSON.parse(text);
    const validated = parsedUpdateSchema.safeParse(parsedJson);
    if (validated.success) {
      return validated.data;
    }
    return heuristicParseClinicalNote(note);
  } catch (error) {
    console.warn("Gemini clinical parse failed, using heuristic parser:", error instanceof Error ? error.message : error);
    return heuristicParseClinicalNote(note);
  }
}

/** Converts a parsed clinical update into one or more valid ChartEvents. */
export function createChartEventsFromParsedUpdate(
  patientId: string,
  parsed: ParsedClinicalUpdate,
  rawText: string,
  now = new Date(),
): ChartEvent[] {
  const timestamp = now.toISOString();
  const events: ChartEvent[] = [];

  // If vitals were extracted, add vital event
  if (parsed.vital && Object.values(parsed.vital).some((v) => v !== undefined)) {
    events.push({
      id: randomUUID(),
      patientId,
      category: "vital",
      occurredAt: timestamp,
      recordedAt: timestamp,
      sourceLabel: "Bedside vital sign (AI parsed)",
      payload: parsed.vital,
    });
  }

  // Primary event based on category
  if (parsed.category === "medication" && parsed.medication) {
    events.push({
      id: randomUUID(),
      patientId,
      category: "medication",
      occurredAt: timestamp,
      recordedAt: timestamp,
      sourceLabel: "Bedside medication entry (AI parsed)",
      payload: {
        medicationName: parsed.medication.medicationName,
        dose: parsed.medication.dose,
        route: parsed.medication.route,
        scheduleType: parsed.medication.scheduleType,
        status: parsed.medication.status,
      },
    });
  } else if (parsed.category === "task" && parsed.task) {
    events.push({
      id: randomUUID(),
      patientId,
      category: "task",
      occurredAt: timestamp,
      recordedAt: timestamp,
      sourceLabel: "Bedside nursing task (AI parsed)",
      payload: {
        title: parsed.task.title,
        status: parsed.task.status,
      },
    });
  } else if (parsed.category === "incident" && parsed.incident) {
    events.push({
      id: randomUUID(),
      patientId,
      category: "incident",
      occurredAt: timestamp,
      recordedAt: timestamp,
      sourceLabel: "Bedside incident report (AI parsed)",
      payload: {
        description: parsed.incident.description,
        resolved: parsed.incident.resolved,
      },
    });
  } else if (parsed.category === "nursing_note" || events.length === 0) {
    events.push({
      id: randomUUID(),
      patientId,
      category: "nursing_note",
      occurredAt: timestamp,
      recordedAt: timestamp,
      sourceLabel: "Bedside nursing observation (AI parsed)",
      payload: {
        summary: parsed.summary || rawText,
      },
    });
  }

  // If a vital was captured AND there was meaningful contextual prose that wasn't captured yet, also record note
  if (parsed.vital && !events.some((e) => e.category === "nursing_note") && rawText.length > 25) {
    events.push({
      id: randomUUID(),
      patientId,
      category: "nursing_note",
      occurredAt: timestamp,
      recordedAt: timestamp,
      sourceLabel: "Bedside nursing observation (AI parsed)",
      payload: {
        summary: parsed.summary || rawText,
      },
    });
  }

  return events;
}
