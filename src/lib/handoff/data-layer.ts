import { randomUUID } from "node:crypto";
import type {
  ChartEvent,
  HandoffPublication,
  HandoffVersion,
  Patient,
  VitalMonitoringPlan,
} from "@/lib/contracts";
import { handoffVersionSchema } from "@/lib/contracts";
import { createDemoUnit, type DemoUnit } from "@/lib/demo/seed-data";

export type ProtocolChunk = { id: string; text: string };
export type HandoffVersionDraft = Omit<HandoffVersion, "id" | "versionNumber">;
export type PublicationDraft = Omit<HandoffPublication, "id">;

/** Reads synthetic patient context through fixture or server-side data sources. */
export interface EventSource {
  getPatient(patientId: string): Promise<Patient | null>;
  getEvents(patientId: string): Promise<ChartEvent[]>;
}

/** Selects the synthetic monitoring plan associated with a trigger event. */
export interface PlanSource {
  getPlan(patientId: string, triggerEventId: string): Promise<VitalMonitoringPlan | null>;
}

/** Retrieves protocol context; it is reference material, never a source of thresholds. */
export interface KnowledgeSource {
  retrieve(query: string, limit: number): Promise<ProtocolChunk[]>;
}

/** Stores immutable candidate and failed versions. */
export interface VersionStore {
  append(draft: HandoffVersionDraft): Promise<HandoffVersion>;
  get(versionId: string): Promise<HandoffVersion | null>;
  list(patientId: string): Promise<HandoffVersion[]>;
  registerReviewThread(versionId: string, threadId: string): Promise<void>;
  getReviewThreadId(versionId: string): Promise<string | null>;
}

/** Appends publication events separately from immutable versions. */
export interface PublicationStore {
  appendPublication(draft: PublicationDraft): Promise<HandoffPublication>;
  listPublications(patientId: string): Promise<HandoffPublication[]>;
}

export type HandoffDataLayer = EventSource & PlanSource & KnowledgeSource & VersionStore & PublicationStore;

const fixtureProtocolChunks: ProtocolChunk[] = [
  { id: "fixture-format", text: "Write concise, factual handoff statements and identify their source events." },
  { id: "fixture-safety", text: "Do not infer clinical meaning or add facts that are absent from the source events." },
  { id: "fixture-review", text: "A draft remains a candidate until a person explicitly approves it." },
];

function copy<T>(value: T): T {
  return structuredClone(value);
}

function vitalTypeFor(event: ChartEvent): VitalMonitoringPlan["vitalType"] | null {
  if (event.category !== "vital") return null;
  if (event.payload.systolicBloodPressure !== undefined) return "blood_pressure";
  if (event.payload.heartRate !== undefined) return "heart_rate";
  if (event.payload.temperatureCelsius !== undefined) return "temperature";
  if (event.payload.oxygenSaturation !== undefined) return "oxygen_saturation";
  if (event.payload.bloodGlucose !== undefined) return "blood_glucose";
  return null;
}

/** In-memory ports used by every Phase 1 graph test; they make no network calls. */
export class InMemoryHandoffDataLayer implements HandoffDataLayer {
  private readonly patients = new Map<string, Patient>();
  private readonly events = new Map<string, ChartEvent[]>();
  private readonly plans: VitalMonitoringPlan[];
  private readonly versions: HandoffVersion[] = [];
  private readonly publications: HandoffPublication[] = [];
  private readonly reviewThreads = new Map<string, string>();

  constructor(unit: DemoUnit = createDemoUnit()) {
    for (const patient of unit.patients) this.patients.set(patient.id, copy(patient));
    for (const event of unit.chartEvents) {
      const patientEvents = this.events.get(event.patientId) ?? [];
      patientEvents.push(copy(event));
      this.events.set(event.patientId, patientEvents);
    }
    this.plans = copy(unit.vitalMonitoringPlans);
  }

  /** Replaces a patient's fixture context for a single graph run. */
  setPatientEvents(patient: Patient, events: ChartEvent[]): void {
    this.patients.set(patient.id, copy(patient));
    this.events.set(patient.id, copy(events));
  }

  async getPatient(patientId: string): Promise<Patient | null> {
    const patient = this.patients.get(patientId);
    return patient ? copy(patient) : null;
  }

  async getEvents(patientId: string): Promise<ChartEvent[]> {
    return copy(this.events.get(patientId) ?? []);
  }

  async getPlan(patientId: string, triggerEventId: string): Promise<VitalMonitoringPlan | null> {
    const trigger = this.events.get(patientId)?.find((event) => event.id === triggerEventId);
    const vitalType = trigger ? vitalTypeFor(trigger) : null;
    if (!vitalType) return null;
    const plan = this.plans.find((item) => item.patientId === patientId && item.vitalType === vitalType);
    return plan ? copy(plan) : null;
  }

  async retrieve(_query: string, limit: number): Promise<ProtocolChunk[]> {
    return copy(fixtureProtocolChunks.slice(0, Math.min(3, Math.max(0, limit))));
  }

  async append(draft: HandoffVersionDraft): Promise<HandoffVersion> {
    const version = handoffVersionSchema.parse({
      ...draft,
      id: randomUUID(),
      versionNumber: this.versions.filter((item) => item.patientId === draft.patientId).length + 1,
    });
    this.versions.push(copy(version));
    return copy(version);
  }

  async get(versionId: string): Promise<HandoffVersion | null> {
    const version = this.versions.find((item) => item.id === versionId);
    return version ? copy(version) : null;
  }

  async list(patientId: string): Promise<HandoffVersion[]> {
    return copy(this.versions.filter((item) => item.patientId === patientId));
  }

  async registerReviewThread(versionId: string, threadId: string): Promise<void> {
    const version = this.versions.find((item) => item.id === versionId);
    if (!version || version.status !== "candidate" || this.reviewThreads.has(versionId)) {
      throw new Error("A review thread can only be registered once for a stored candidate.");
    }
    this.reviewThreads.set(versionId, threadId);
  }

  async getReviewThreadId(versionId: string): Promise<string | null> {
    return this.reviewThreads.get(versionId) ?? null;
  }

  async appendPublication(draft: PublicationDraft): Promise<HandoffPublication> {
    const version = this.versions.find((item) => item.id === draft.handoffVersionId);
    if (!version || version.patientId !== draft.patientId || version.status !== "candidate") {
      throw new Error("Only a stored candidate for this synthetic patient can be published.");
    }
    if (this.publications.some((item) => item.handoffVersionId === draft.handoffVersionId)) {
      throw new Error("This immutable candidate already has a publication event.");
    }
    const publication: HandoffPublication = { ...draft, id: randomUUID() };
    this.publications.push(copy(publication));
    return copy(publication);
  }

  async listPublications(patientId: string): Promise<HandoffPublication[]> {
    return copy(this.publications.filter((item) => item.patientId === patientId));
  }

}
