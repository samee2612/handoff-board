import { z } from "zod";
import type {
  ChartEvent,
  ExtractedFact,
  HandoffClaim,
  SbarSection,
  SpecialistName,
  VerificationDecision,
} from "@/lib/contracts";
import { HandoffPipelineError } from "@/lib/handoff/errors";
import type { StructuredOutputClient } from "@/lib/handoff/structured-output";

const specialistFactOutputSchema = z
  .object({
    facts: z.array(
      z
        .object({
          summary: z.string(),
          evidenceEventIds: z.array(z.string().uuid()),
        })
        .strict(),
    ),
  })
  .strict();

const synthesisOutputSchema = z
  .object({
    claims: z.array(
      z
        .object({
          section: z.enum(["situation", "background", "assessment", "recommendation"]),
          text: z.string(),
          evidenceEventIds: z.array(z.string().uuid()),
        })
        .strict(),
    ),
  })
  .strict();

const verificationOutputSchema = z
  .object({
    decisions: z.array(
      z
        .object({
          claimId: z.string(),
          status: z.enum(["supported", "gap"]),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type SpecialistResult = { specialist: SpecialistName; facts: ExtractedFact[] };

export interface SpecialistAgent {
  readonly name: SpecialistName;
  readonly model: string;
  extract(events: ChartEvent[]): Promise<SpecialistResult>;
}

function promptEvents(events: ChartEvent[]) {
  return events.map(({ id, category, occurredAt, sourceLabel, payload }) => ({ id, category, occurredAt, sourceLabel, payload }));
}

function factSummary(event: ChartEvent): string {
  switch (event.category) {
    case "nursing_note":
      return event.payload.summary;
    case "vital":
      return `Recorded vitals: ${Object.entries(event.payload)
        .map(([name, value]) => `${name} ${value}`)
        .join(", ")}.`;
    case "medication":
      return `Medication record: ${event.payload.medicationName} ${event.payload.dose} ${event.payload.route}; ${event.payload.scheduleType} status ${event.payload.status}.`;
    case "task":
      return `Task record: ${event.payload.title}; status ${event.payload.status}.`;
    case "incident":
      return `Incident record: ${event.payload.description}; resolved ${event.payload.resolved ? "yes" : "no"}.`;
  }
}

class EventSpecialist implements SpecialistAgent {
  readonly model: string;

  constructor(
    readonly name: SpecialistName,
    private readonly categories: ChartEvent["category"][],
    private readonly client?: StructuredOutputClient,
  ) {
    this.model = client?.model ?? "deterministic-fixture";
  }

  async extract(events: ChartEvent[]): Promise<SpecialistResult> {
    const scopedEvents = events.filter((event) => this.categories.includes(event.category));
    if (!this.client) {
      return {
        specialist: this.name,
        facts: scopedEvents.map((event) => ({
          id: `${this.name}:${event.id}`,
          specialist: this.name,
          summary: factSummary(event),
          evidenceEventIds: [event.id],
        })),
      };
    }

    const output = await this.client.generate({
      schema: specialistFactOutputSchema,
      schemaName: `${this.name}_facts`,
      instructions: [
        `You are the ${this.name} extraction specialist for a synthetic-data nursing handoff demo.`,
        "Extract only explicit facts from the supplied events in your specialty.",
        "Every fact must cite one or more supplied event IDs. Do not infer trends, urgency, medication timing, eligibility, or care recommendations.",
        "Return no facts if the supplied events do not support one.",
      ].join(" "),
      input: { events: promptEvents(scopedEvents) },
    });

    const allowedEventIds = new Set(scopedEvents.map((event) => event.id));
    return {
      specialist: this.name,
      facts: output.facts.map((fact, index) => {
        if (fact.evidenceEventIds.length === 0 || fact.evidenceEventIds.some((id) => !allowedEventIds.has(id))) {
          throw new HandoffPipelineError("INVALID_SPECIALIST_EVIDENCE", `${this.name} cited an event outside its input`);
        }
        return {
          id: `${this.name}:${index}:${fact.evidenceEventIds.slice().sort().join("-")}`,
          specialist: this.name,
          summary: fact.summary,
          evidenceEventIds: fact.evidenceEventIds,
        };
      }),
    };
  }
}

export class ChartVitalsSpecialist extends EventSpecialist {
  constructor(client?: StructuredOutputClient) {
    super("chart_vitals", ["nursing_note", "vital"], client);
  }
}

export class MedicationSpecialist extends EventSpecialist {
  constructor(client?: StructuredOutputClient) {
    super("medications", ["medication"], client);
  }
}

export class TasksIncidentsSpecialist extends EventSpecialist {
  constructor(client?: StructuredOutputClient) {
    super("tasks_incidents", ["task", "incident"], client);
  }
}

export class SbarSynthesizer {
  readonly model: string;

  constructor(private readonly client?: StructuredOutputClient) {
    this.model = client?.model ?? "deterministic-fixture";
  }

  async synthesize(facts: ExtractedFact[], events: ChartEvent[]): Promise<HandoffClaim[]> {
    const eventById = new Map(events.map((event) => [event.id, event]));
    if (!this.client) {
      return facts.map((fact, index) => ({
        id: `claim:${index}:${fact.id}`,
        section: sectionForFact(fact, eventById),
        text: fact.summary,
        evidenceEventIds: fact.evidenceEventIds,
      }));
    }

    const output = await this.client.generate({
      schema: synthesisOutputSchema,
      schemaName: "sbar_handoff", 
      instructions: [
        "Create a concise SBAR handoff from the supplied evidence-backed facts for a synthetic-data demo.",
        "Use only supplied facts and cite supplied event IDs on every claim.",
        "Do not calculate due times, medication eligibility, priority, or freshness. Do not make clinical recommendations or add clinical knowledge.",
        "An empty section is preferable to an unsupported claim.",
      ].join(" "),
      input: { facts },
    });

    const factEventIds = new Set(facts.flatMap((fact) => fact.evidenceEventIds));
    return output.claims.map((claim, index) => {
      if (claim.evidenceEventIds.length === 0 || claim.evidenceEventIds.some((id) => !factEventIds.has(id))) {
        throw new HandoffPipelineError("INVALID_SYNTHESIS_EVIDENCE", "The synthesizer cited evidence absent from specialist facts");
      }
      return { id: `claim:${index}`, ...claim };
    });
  }
}

function sectionForFact(fact: ExtractedFact, eventById: Map<string, ChartEvent>): SbarSection {
  const category = eventById.get(fact.evidenceEventIds[0])?.category;
  if (category === "nursing_note") return "situation";
  if (category === "medication") return "background";
  if (category === "task") return "recommendation";
  return "assessment";
}

export class EvidenceVerifier {
  readonly model: string;

  constructor(private readonly client?: StructuredOutputClient) {
    this.model = client?.model ?? "deterministic-fixture";
  }

  async verify(claims: HandoffClaim[], facts: ExtractedFact[], events: ChartEvent[]): Promise<VerificationDecision[]> {
    const factEventIds = new Set(facts.flatMap((fact) => fact.evidenceEventIds));
    const eventById = new Map(events.map((event) => [event.id, event]));
    if (!this.client) {
      return claims.map((claim) => ({
        claimId: claim.id,
        status: claim.evidenceEventIds.every((id) => factEventIds.has(id) && eventById.has(id)) ? "supported" : "gap",
        reason: claim.evidenceEventIds.every((id) => factEventIds.has(id) && eventById.has(id))
          ? "All cited event IDs are present in the verified specialist evidence."
          : "One or more cited event IDs are not present in verified specialist evidence.",
      }));
    }

    const output = await this.client.generate({
      schema: verificationOutputSchema,
      schemaName: "evidence_verification",
      instructions: [
        "Independently verify each proposed synthetic SBAR claim against the supplied specialist facts and source events.",
        "Mark supported only when the cited event IDs and supplied text directly support the claim. Otherwise mark gap.",
        "Do not create claims, alter citations, infer timing, or provide medical advice.",
      ].join(" "),
      input: { claims, facts, events: promptEvents(events) },
    });

    const decisions = new Map(output.decisions.map((decision) => [decision.claimId, decision]));
    if (decisions.size !== claims.length || claims.some((claim) => !decisions.has(claim.id))) {
      throw new HandoffPipelineError("INCOMPLETE_VERIFICATION", "The verifier did not return one decision for every claim");
    }
    return claims.map((claim) => decisions.get(claim.id)!);
  }
}
