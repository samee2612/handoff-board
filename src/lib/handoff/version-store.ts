import { randomUUID } from "node:crypto";
import type { AgentDiagnostic, HandoffClaim, HandoffFailure, HandoffVersion } from "@/lib/contracts";
import { handoffVersionSchema } from "@/lib/contracts";

export type HandoffVersionDraft = Omit<HandoffVersion, "id" | "versionNumber">;

export interface HandoffVersionStore {
  append(draft: HandoffVersionDraft): HandoffVersion;
  list(patientId: string): HandoffVersion[];
  current(patientId: string): HandoffVersion | null;
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/** Append-only fixture store. The returned copies cannot mutate stored handoff history. */
export class InMemoryHandoffVersionStore implements HandoffVersionStore {
  private readonly versions: HandoffVersion[] = [];

  append(draft: HandoffVersionDraft): HandoffVersion {
    const version: HandoffVersion = handoffVersionSchema.parse({
      ...draft,
      id: randomUUID(),
      versionNumber: this.versions.filter((item) => item.patientId === draft.patientId).length + 1,
    });
    this.versions.push(snapshot(version));
    return snapshot(version);
  }

  list(patientId: string): HandoffVersion[] {
    return this.versions.filter((version) => version.patientId === patientId).map(snapshot);
  }

  current(patientId: string): HandoffVersion | null {
    const published = this.versions.filter((version) => version.patientId === patientId && version.status === "published");
    return published.length === 0 ? null : snapshot(published[published.length - 1]);
  }
}

export function failedVersionDraft(input: {
  patientId: string;
  sourceEventCutoff: string;
  generatedAt: string;
  model: string;
  diagnostics: AgentDiagnostic[];
  failure: HandoffFailure;
}): HandoffVersionDraft {
  return { ...input, status: "failed", claims: [], excludedClaims: [], failure: input.failure };
}

export function publishedVersionDraft(input: {
  patientId: string;
  sourceEventCutoff: string;
  generatedAt: string;
  model: string;
  diagnostics: AgentDiagnostic[];
  claims: HandoffClaim[];
  excludedClaims: HandoffVersion["excludedClaims"];
}): HandoffVersionDraft {
  return { ...input, status: "published", failure: null };
}
