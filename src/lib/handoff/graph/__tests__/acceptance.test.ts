import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import type { ChartEvent, HandoffClaim, Patient, VitalMonitoringPlan } from "@/lib/contracts";
import { makePatient } from "./fixtures";
import { ScriptedLlm } from "./scripted-llm";
import { InMemoryHandoffDataLayer } from "@/lib/handoff/data-layer";
import {
  ChartVitalsSpecialist,
  EvidenceVerifier,
  MedicationSpecialist,
  SbarSynthesizer,
  TasksIncidentsSpecialist,
} from "@/lib/handoff/agents";
import { buildHandoffGraph, type HandoffGraphState } from "../index";
import type { HandoffVersion } from "@/lib/contracts";

type NoteEntry = { id: string; time: string; text: string };
type NoteFile = { patient_id: string; entries: NoteEntry[] };
type ClaimLine = { text: string; evidenceEventIds: string[] };
type AcceptanceRun = {
  graph: ReturnType<typeof buildHandoffGraph>;
  data: AcceptanceDataLayer;
  llm: ScriptedLlm;
  input: HandoffGraphState;
  state?: HandoffGraphState;
  error?: Error;
};

const temporaryDirectories: string[] = [];
const FIXTURE_DATE = "2026-10-11";
const PLAN_ID = "77777777-7777-4777-8777-777777777771";
const UNIT_ID = "11111111-1111-4111-8111-111111111111";
const NURSE_ID = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function readNotes(fileName: string): NoteFile {
  return JSON.parse(readFileSyncData(fileName)) as NoteFile;
}

function readFileSyncData(fileName: string): string {
  return readFileSync(join(process.cwd(), "data", fileName), "utf8");
}

function isoTime(value: string): string {
  const match = value.match(/^(\d{2}):?(\d{2})$/);
  if (!match) throw new Error(`Unexpected note time format '${value}'.`);
  return `${FIXTURE_DATE}T${match[1]}:${match[2]}:00.000Z`;
}

function noteEvent(note: NoteEntry, patientId: string, index: number): ChartEvent {
  const base = {
    id: `evt-${index + 1}`,
    patientId,
    occurredAt: isoTime(note.time),
    recordedAt: isoTime(note.time),
    sourceLabel: `Synthetic note ${note.id}`,
  };

  let event: ChartEvent;
  if (/^task:/i.test(note.text)) {
    const dueTime = note.text.match(/\bdue\s*(\d{4})\b/i)?.[1];
    event = {
      ...base,
      category: "task",
      payload: {
        title: note.text.replace(/^task:\s*/i, ""),
        ...(dueTime ? { dueAt: isoTime(dueTime) } : {}),
        status: "open",
      },
    };
  } else if (note.id === "n3") {
    event = {
      ...base,
      category: "task",
      payload: { title: note.text, dueAt: isoTime("17:00"), status: "open" },
    };
  } else if (note.id === "m10") {
    event = {
      ...base,
      category: "medication",
      payload: {
        medicationName: "metoprolol",
        dose: "25mg",
        route: "PO",
        scheduleType: "scheduled",
        dueAt: isoTime(note.time),
        status: "held",
      },
    };
  } else {
    event = { ...base, category: "nursing_note", payload: { summary: note.text } };
  }

  // Preserve the input's literal IDs here so the acceptance test exercises their real contracts.
  Reflect.set(event, "id", note.id);
  Reflect.set(event, "patientId", patientId);
  return event;
}

function monitoringPlan(patientId: string): VitalMonitoringPlan {
  return {
    id: PLAN_ID,
    patientId,
    vitalType: "blood_pressure",
    urgentBelow: 90,
    attentionBelow: 100,
    intervalMinutes: 60,
  };
}

class AcceptanceDataLayer extends InMemoryHandoffDataLayer {
  constructor(
    private readonly patientRecord: Patient,
    private readonly noteEvents: ChartEvent[],
    private readonly plan: VitalMonitoringPlan,
  ) {
    super();
    this.setPatientEvents(patientRecord, noteEvents);
  }

  override async getPatient(_patientId: string): Promise<Patient> {
    return structuredClone(this.patientRecord);
  }

  override async getEvents(_patientId: string): Promise<ChartEvent[]> {
    return structuredClone(this.noteEvents);
  }

  override async getPlan(_patientId: string, _triggerEventId: string): Promise<VitalMonitoringPlan> {
    return structuredClone(this.plan);
  }
}

function defaultResponse(nodeName: string, input: unknown): unknown {
  const value = input as {
    events?: Array<{ id: string; payload: Record<string, unknown> }>;
    facts?: Array<{ summary: string; evidenceEventIds: string[] }>;
    claims?: Array<{ id: string }>;
  };
  if (["chart_vitals", "medications", "tasks_incidents"].includes(nodeName)) {
    return {
      facts: (value.events ?? []).map((event) => {
        const summary = String(
          event.payload.summary ?? event.payload.title ?? event.payload.medicationName ?? "",
        );
        return {
          summary: summary.replace(/\bBP\s+1O4\/6O\b/i, "BP value omitted as a possible typo"),
          evidenceEventIds: [event.id],
        };
      }),
    };
  }
  if (nodeName === "synthesize_sbar") {
    return { claims: (value.facts ?? []).map((fact) => ({
      section: "assessment",
      text: fact.summary,
      evidenceEventIds: fact.evidenceEventIds,
    })) };
  }
  return {
    decisions: (value.claims ?? []).map((claim) => ({
      claimId: claim.id,
      status: "supported",
      reason: "Scripted verifier accepts the line.",
    })),
  };
}

function makeRun(fileName: string, options: {
  firstDraft?: ClaimLine[];
  secondDraft?: ClaimLine[];
  routineOnly?: boolean;
} = {}): AcceptanceRun {
  const notes = readNotes(fileName);
  const patient = makePatient();
  Reflect.set(patient, "id", notes.patient_id);
  const events = notes.entries.map((entry, index) => noteEvent(entry, notes.patient_id, index));
  const plan = monitoringPlan(patient.id);
  const data = new AcceptanceDataLayer(patient, events, plan);
  const llm = new ScriptedLlm(defaultResponse);

  if (options.firstDraft) {
    llm.queue("synthesize_sbar", { claims: options.firstDraft.map((line) => ({
      section: "assessment",
      ...line,
    })) });
  }
  if (options.secondDraft) {
    llm.queue("synthesize_sbar", { claims: options.secondDraft.map((line) => ({
      section: "assessment",
      ...line,
    })) });
  }
  if (options.routineOnly) {
    llm.queue("synthesize_sbar", {
      claims: [{
        section: "assessment",
        text: "routine",
        evidenceEventIds: [notes.entries[0].id],
      }],
    });
  }

  const graph = buildHandoffGraph({
    data,
    agents: {
      specialists: {
        chart_vitals: new ChartVitalsSpecialist(llm),
        medications: new MedicationSpecialist(llm),
        tasks_incidents: new TasksIncidentsSpecialist(llm),
      },
      synthesizer: new SbarSynthesizer(llm),
      verifier: new EvidenceVerifier(llm),
    },
  }, new MemorySaver());
  const trigger = notes.entries.find((entry) => /bp\s+\d{2,3}\/\d{2,3}/i.test(entry.text)) ?? notes.entries[0];
  const input: HandoffGraphState = {
    patientId: notes.patient_id,
    triggerEventId: trigger.id,
    runId: randomUUID(),
    generatedAt: isoTime(notes.entries.at(-1)!.time),
    events: [],
    plan: null,
    attention: null,
    nextDueAt: null,
    protocolChunks: [],
    facts: [],
    flags: [],
    claims: [],
    decisions: [],
    retryCount: 0,
    maxRetries: 1,
    gapFeedback: [],
    supportedClaims: [],
    excludedClaims: [],
    diagnostics: [],
    versionId: null,
    reviewDecision: null,
    status: "running",
    failure: null,
  };

  return { graph, data, llm, input };
}

async function execute(run: AcceptanceRun): Promise<AcceptanceRun> {
  try {
    run.state = await run.graph.invoke(run.input, {
      configurable: { thread_id: run.input.runId },
    });
  } catch (error) {
    run.error = error instanceof Error ? error : new Error(String(error));
  }
  return run;
}

function atReview(run: AcceptanceRun): HandoffGraphState {
  expect(run.error, run.error?.message).toBeUndefined();
  expect(run.state?.status).toBe("awaiting_review");
  return run.state!;
}

function expectClaim(
  claims: HandoffClaim[],
  predicate: (claim: HandoffClaim) => boolean,
  sourceIds: string[],
): HandoffClaim {
  const found = claims.find(predicate);
  expect(found, `Expected a handoff line citing ${sourceIds.join(", ")}`).toBeDefined();
  expect(found!.evidenceEventIds).toEqual(sourceIds);
  return found!;
}

function demoOneClaims(): ClaimLine[] {
  return [
    { text: "BP 88/54 at 16:00", evidenceEventIds: ["n1"] },
    { text: "Patient reports feeling dizzy", evidenceEventIds: ["n2"] },
    { text: "Recheck BP before 17:00", evidenceEventIds: ["n3"] },
  ];
}

const messyCorrectClaims: ClaimLine[] = [
  { text: "Systolic BP decreased 122/78, 110/70, 98/60, 88/54", evidenceEventIds: ["m02", "m06", "m12", "m14"] },
  { text: "BP 88/54; dizzy when sitting up", evidenceEventIds: ["m14"] },
  { text: "Dr Chen paged and reviewed the patient", evidenceEventIds: ["m15", "m19"] },
  { text: "Latest BP 101/64, HR 98", evidenceEventIds: ["m20"] },
  { text: "Metoprolol 25mg due and held", evidenceEventIds: ["m10"] },
  { text: "IV bolus of 500 ml started at 16:40 per verbal order", evidenceEventIds: ["m16"] },
  { text: "IV cannula change due 12:00", evidenceEventIds: ["m03"] },
  { text: "BP recheck requested before 17:00", evidenceEventIds: ["m17"] },
];

function printTerminal(name: string, run: AcceptanceRun): void {
  const state = run.state;
  const claims = state?.supportedClaims.length
    ? state.supportedClaims
    : state?.claims ?? [];
  const problems = [
    ...(state?.excludedClaims.map(({ claim, reason }) => `${claim.text}: ${reason}`) ?? []),
    ...(state?.failure ? [`${state.failure.code}: ${state.failure.message}`] : []),
    ...(run.error ? [run.error.message] : []),
  ];
  const lines = [
    `\n=== ${name} | SYNTHETIC DATA ONLY — NOT FOR CLINICAL USE ===`,
    "Draft bullets:",
    ...(claims.length
      ? claims.map((claim) => `  - ${claim.text} [${claim.evidenceEventIds.join(", ")}]`)
      : ["  - unavailable"]),
    "Checks:",
    ...(state?.decisions.length
      ? state.decisions.map((decision) => `  - ${decision.status}: ${decision.reason}`)
      : ["  - none completed"]),
    "Problems:",
    ...(problems.length ? problems.map((problem) => `  - ${problem}`) : ["  - none"]),
    "Flags:",
    ...(state?.flags.length
      ? state.flags.map((flag) => `  - ${flag.message} [${flag.evidenceEventIds.join(", ")}]`)
      : ["  - none"]),
    state?.status === "awaiting_review"
      ? "Approval: awaiting human review; no output saved"
      : "Approval: unavailable; no output saved",
  ];
  console.log(lines.join("\n"));
}

async function approvedOutput(run: AcceptanceRun, directory: string): Promise<{
  state?: HandoffGraphState;
  outputPath: string;
  version?: HandoffVersion;
}> {
  const reviewState = atReview(run);
  const state = await run.graph.invoke(
    new (await import("@langchain/langgraph")).Command({ resume: "approved" }),
    { configurable: { thread_id: run.input.runId } },
  );
  const version = await run.data.get(reviewState.versionId ?? "");
  const outputPath = join(directory, `handoff_${run.input.patientId}.json`);
  if (state.status === "published" && version) {
    const attempts = run.llm.callsFor("synthesize_sbar").length;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, JSON.stringify({
      status: "approved",
      attempts,
      attention: reviewState.attention,
      lines: version.claims,
      excluded: version.excludedClaims,
      flags: reviewState.flags.filter((flag) => flag.kind !== "urgent_attention"),
    }, null, 2)));
  }
  return { state, outputPath, version: version ?? undefined };
}

describe("full-graph product acceptance: notes.json", () => {
  it("demo 1 produces three cited lines, all passing", async () => {
    const run = await execute(makeRun("notes.json", { firstDraft: demoOneClaims() }));
    const state = atReview(run);
    expect(state.supportedClaims).toHaveLength(3);
    expect(state.decisions.every((decision) => decision.status === "supported")).toBe(true);
    expect(state.supportedClaims.map((claim) => claim.evidenceEventIds[0]).sort()).toEqual(["n1", "n2", "n3"]);
  }, 10_000);

  it("demo 1 flags 88/54 as urgent from the rule", async () => {
    const run = await execute(makeRun("notes.json", { routineOnly: true }));
    printTerminal("Demo 1", run);
    const state = atReview(run);
    expect(state.attention).toBe("urgent");
    expect(state.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "urgent_attention", evidenceEventIds: ["n1"] }),
    ]));
  }, 10_000);

  it("demo 1 does not save before approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "handoff-acceptance-"));
    temporaryDirectories.push(directory);
    const run = await execute(makeRun("notes.json", { firstDraft: demoOneClaims() }));
    const state = atReview(run);
    expect(state.status).toBe("awaiting_review");
    expect(await import("node:fs/promises").then(({ access }) =>
      access(join(directory, "handoff_demo-patient-1.json")).then(() => true, () => false),
    )).toBe(false);
  }, 10_000);

  it("demo 1 saves the approved handover after y", async () => {
    const directory = await mkdtemp(join(tmpdir(), "handoff-acceptance-"));
    temporaryDirectories.push(directory);
    const run = await execute(makeRun("notes.json", { firstDraft: demoOneClaims() }));
    const output = await approvedOutput(run, directory);
    expect(output.state?.status).toBe("published");
    expect(output.version?.claims).toHaveLength(3);
    expect(output.outputPath).toContain("handoff_demo-patient-1.json");
  }, 10_000);
});

describe("full-graph product acceptance: notes-messy.json", () => {
  function messyRun() {
    return execute(makeRun("notes-messy.json", {
      firstDraft: [
        ...messyCorrectClaims.filter((claim) => claim.evidenceEventIds[0] !== "m16"),
        { text: "IV bolus of 1 litre started at 16:40", evidenceEventIds: ["m16"] },
      ],
      secondDraft: messyCorrectClaims,
    }));
  }

  it("messy shift trend line cites the four BP sources", async () => {
    const run = await messyRun();
    const state = atReview(run);
    const trend = expectClaim(state.supportedClaims, (claim) => /122\/78.*110\/70.*98\/60.*88\/54/.test(claim.text), ["m02", "m06", "m12", "m14"]);
    expect(trend.text).toContain("122/78");
    expect(state.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        summary: expect.stringContaining("decreased from 122 to 88"),
        evidenceEventIds: ["m02", "m06", "m12", "m14"],
      }),
    ]));
  }, 10_000);

  it("messy shift lowest BP line cites m14", async () => {
    const state = atReview(await messyRun());
    expectClaim(state.supportedClaims, (claim) => claim.text.includes("88/54") && /dizz/i.test(claim.text), ["m14"]);
  }, 10_000);

  it("messy shift includes a line for the Dr Chen page and review", async () => {
    const state = atReview(await messyRun());
    expectClaim(state.supportedClaims, (claim) => /Dr Chen.*paged.*review/i.test(claim.text), ["m15", "m19"]);
  }, 10_000);

  it("messy shift includes the latest BP line from m20", async () => {
    const state = atReview(await messyRun());
    expectClaim(state.supportedClaims, (claim) => claim.text.includes("101/64"), ["m20"]);
  }, 10_000);

  it("messy shift includes the held metoprolol line from m10", async () => {
    const state = atReview(await messyRun());
    expectClaim(state.supportedClaims, (claim) => /metoprolol.*held/i.test(claim.text), ["m10"]);
  }, 10_000);

  it("messy shift includes the verbal-order bolus line citing m16 with 500 ml", async () => {
    const state = atReview(await messyRun());
    expectClaim(state.supportedClaims, (claim) => /500\s*ml/i.test(claim.text) && /verbal order/i.test(claim.text), ["m16"]);
  }, 10_000);

  it("messy shift attempt 1 with 1 litre is rejected by code", async () => {
    const run = await messyRun();
    const state = atReview(run);
    expect(run.llm.callsFor("synthesize_sbar")).toHaveLength(2);
    expect(state.excludedClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        claim: expect.objectContaining({ text: "IV bolus of 1 litre started at 16:40", evidenceEventIds: ["m16"] }),
        reason: expect.stringMatching(/number.*1.*not.*cited|number.*1.*absent/i),
      }),
    ]));
  }, 10_000);

  it("messy shift attempt 2 passes all lines", async () => {
    const state = atReview(await messyRun());
    expect(state.retryCount).toBe(1);
    expect(state.supportedClaims).toHaveLength(8);
    expect(state.decisions.every((decision) => decision.status === "supported")).toBe(true);
  }, 10_000);

  it("messy shift flags the typo at m18 and does not use it as a clinical line", async () => {
    const state = atReview(await messyRun());
    expect(state.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "data_quality",
        evidenceEventIds: ["m18"],
        message: expect.stringMatching(/typo|parse|unreadable/i),
      }),
    ]));
    expect(state.supportedClaims.some((claim) => claim.evidenceEventIds.includes("m18"))).toBe(false);
    expect(state.facts.some((fact) => fact.summary.includes("1O4/6O"))).toBe(false);
  }, 10_000);

  it("messy shift flags the overdue cannula task m03", async () => {
    const state = atReview(await messyRun());
    expect(state.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "overdue_task",
        evidenceEventIds: ["m03"],
        message: expect.stringMatching(/12:00|overdue/i),
      }),
    ]));
  }, 10_000);

  it("messy shift urgent flag is from the rule for 88/54 at 16:00", async () => {
    const run = await messyRun();
    printTerminal("Demo 2 (messy shift)", run);
    const state = atReview(run);
    expect(state.attention).toBe("urgent");
    expect(state.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "urgent_attention", evidenceEventIds: ["m14"] }),
    ]));
  }, 10_000);

  it("messy shift status is awaiting_review and nothing is saved before approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "handoff-acceptance-"));
    temporaryDirectories.push(directory);
    const run = await messyRun();
    const state = atReview(run);
    expect(state.status).toBe("awaiting_review");
    expect(await import("node:fs/promises").then(({ access }) =>
      access(join(directory, "handoff_demo-patient-4.json")).then(() => true, () => false),
    )).toBe(false);
  }, 10_000);

  it("messy shift saves output with attempts 2 and both flags after approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "handoff-acceptance-"));
    temporaryDirectories.push(directory);
    const run = await messyRun();
    const output = await approvedOutput(run, directory);
    expect(output.state?.status).toBe("published");
    expect(output.version?.claims).toHaveLength(8);
    expect(output.version?.excludedClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ claim: expect.objectContaining({ text: "IV bolus of 1 litre started at 16:40" }) }),
    ]));
    const saved = JSON.parse(await readFile(output.outputPath, "utf8")) as {
      attempts: number;
      flags: Array<{ evidenceEventIds: string[] }>;
    };
    expect(saved.attempts).toBe(2);
    expect(saved.flags.map((flag) => flag.evidenceEventIds[0]).sort()).toEqual(["m03", "m18"]);
  }, 10_000);
});

describe("acceptance evidence and deterministic urgency", () => {
  it("a line citing an unknown note ID is rejected", async () => {
    const run = await execute(makeRun("notes-messy.json", {
      firstDraft: [{ text: "Fictional unsupported line", evidenceEventIds: ["m99"] }],
    }));
    const state = atReview(run);
    expect(state.excludedClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ claim: expect.objectContaining({ evidenceEventIds: ["m99"] }) }),
    ]));
  }, 10_000);

  it("a line citing m14 with the number 90 is rejected", async () => {
    const run = await execute(makeRun("notes-messy.json", {
      firstDraft: [{ text: "Systolic BP 90 at 16:00", evidenceEventIds: ["m14"] }],
    }));
    const state = atReview(run);
    expect(state.excludedClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(/number.*90/i) }),
    ]));
  }, 10_000);

  it("the LLM saying routine does not change urgency for any run", async () => {
    for (const fileName of ["notes.json", "notes-messy.json"]) {
      const run = await execute(makeRun(fileName, { routineOnly: true }));
      const state = atReview(run);
      expect(state.attention).toBe("urgent");
    }
  }, 10_000);
});
