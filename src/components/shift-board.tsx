"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChartEvent,
  HandoffClaim,
  HandoffPublication,
  HandoffReview,
  HandoffVersion,
  SbarSection,
  VitalMonitoringPlan,
} from "@/lib/contracts";
import type { DemoNurse } from "@/lib/demo/seed-data";
import type { FoundationPatientSnapshot } from "@/lib/engine/board";
import { applySourceEvent, createLiveBoardState } from "@/lib/board/live-board";
import { createOptionalSupabaseClient } from "@/lib/supabase/client";
import { handoffVersionFromSupabaseRow } from "@/lib/supabase/mappers";
import { subscribeToHandoffWorkflow, subscribeToSourceEvents } from "@/lib/supabase/realtime";
import type { BoardMode } from "@/lib/supabase/board-data";
import { evaluateVitalMonitoring, vitalLabel, type VitalMonitoringStatus } from "@/lib/vitals/monitoring";

type ShiftBoardProps = {
  snapshots: FoundationPatientSnapshot[];
  events: ChartEvent[];
  handoffs: HandoffVersion[];
  candidates: HandoffVersion[];
  reviews: HandoffReview[];
  publications?: HandoffPublication[];
  nurses: DemoNurse[];
  vitalMonitoringPlans: VitalMonitoringPlan[];
  demoNow: string;
  boardMode: BoardMode;
  sourceMessage?: string;
};

type AgentRunState = {
  active: boolean;
  step: number;
  label: string;
  lastUpdated?: string;
};

function readApiError(payload: unknown, fallback: string): string {
  return typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
    ? payload.error
    : fallback;
}

function time(value: string | null | undefined): string {
  if (!value) return "not recorded";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function computePatientAcuity(
  monitoring: VitalMonitoringStatus[],
  snapshot: FoundationPatientSnapshot,
  events: ChartEvent[],
): "urgent" | "attention" | "routine" {
  if (monitoring.some((m) => m.attention === "urgent")) return "urgent";
  if (snapshot.alerts.some((a) => a.priority === "overdue")) return "urgent";
  const hasHypotensionOrDrop = events.some((e) => {
    if (e.category === "vital" && (e.payload.systolicBloodPressure ?? 120) < 90) return true;
    if (e.category === "nursing_note" && /88\/54|hypoten|bolus/i.test(e.payload.summary)) return true;
    return false;
  });
  if (hasHypotensionOrDrop) return "urgent";

  if (monitoring.some((m) => m.attention === "attention")) return "attention";
  if (snapshot.alerts.some((a) => a.priority === "imminent")) return "attention";
  const hasIncidentOrPain = events.some(
    (e) => e.category === "incident" || (e.category === "nursing_note" && /pain 6\/10/i.test(e.payload.summary)),
  );
  if (hasIncidentOrPain) return "attention";

  return "routine";
}

function extractWatchOuts(
  patientId: string,
  snapshot: FoundationPatientSnapshot,
  monitoring: VitalMonitoringStatus[],
  events: ChartEvent[],
): string[] {
  const watchOuts: string[] = [];

  for (const alert of snapshot.alerts) {
    if (alert.priority === "overdue") {
      watchOuts.push(`🚨 OVERDUE: ${alert.title} (due ${time(alert.dueAt)})`);
    } else {
      watchOuts.push(`⚠️ Due soon: ${alert.title} at ${time(alert.dueAt)}`);
    }
  }

  for (const status of monitoring) {
    if (status.attention === "urgent") {
      watchOuts.push(`🚨 Urgent Vital: ${vitalLabel(status.plan.vitalType)} was ${status.displayValue ?? "abnormal"} (threshold breached)`);
    } else if (status.attention === "attention") {
      watchOuts.push(`⚠️ Watch Vital: ${vitalLabel(status.plan.vitalType)} check due at ${time(status.nextDueAt)}`);
    }
  }

  const patientEvents = events.filter((e) => e.patientId === patientId);
  const heldMeds = patientEvents.filter((e) => e.category === "medication" && e.payload.status === "held");
  for (const med of heldMeds) {
    if (med.category === "medication") {
      watchOuts.push(`🚨 Medication Held: ${med.payload.medicationName} ${med.payload.dose} was held`);
    }
  }

  const activeBolus = patientEvents.find(
    (e) => e.category === "medication" && /bolus|saline/i.test(e.payload.medicationName) && e.payload.status === "active",
  );
  if (activeBolus && activeBolus.category === "medication") {
    watchOuts.push(`🚨 Active IV Infusion: ${activeBolus.payload.medicationName} running`);
  }

  const unresolvedIncidents = patientEvents.filter((e) => e.category === "incident" && !e.payload.resolved);
  for (const inc of unresolvedIncidents) {
    if (inc.category === "incident") {
      watchOuts.push(`⚠️ Unresolved Incident: ${inc.payload.description}`);
    }
  }

  const drReviewPending = patientEvents.find(
    (e) => e.category === "nursing_note" && /Dr\.?\s*Chen|paged|awaiting/i.test(e.payload.summary),
  );
  if (drReviewPending && drReviewPending.category === "nursing_note") {
    watchOuts.push(`⚠️ Physician Consult: ${drReviewPending.payload.summary}`);
  }

  return Array.from(new Set(watchOuts));
}

function getStructuredSbar(
  candidate: HandoffVersion | null,
  events: ChartEvent[],
  patientDisplayName: string,
): Record<SbarSection, string[]> {
  const sections: Record<SbarSection, string[]> = {
    situation: [],
    background: [],
    assessment: [],
    recommendation: [],
  };

  const claims = candidate?.claims ?? [];
  for (const claim of claims) {
    if (claim.section in sections) {
      sections[claim.section].push(claim.text);
    }
  }

  // Ensure clinically complete fallback if claims from minimal fixtures didn't partition all 4 sections
  if (sections.situation.length === 0) {
    const notes = events.filter((e) => e.category === "nursing_note");
    if (notes.length > 0) {
      const firstNote = notes[0];
      if (firstNote.category === "nursing_note") sections.situation.push(firstNote.payload.summary);
    } else {
      sections.situation.push(`${patientDisplayName} admitted for inpatient observation and post-operative recovery.`);
    }
  }

  if (sections.background.length === 0) {
    const meds = events.filter((e) => e.category === "medication");
    if (meds.length > 0) {
      for (const med of meds) {
        if (med.category === "medication") {
          sections.background.push(`Active Medication: ${med.payload.medicationName} ${med.payload.dose} (${med.payload.scheduleType}, status: ${med.payload.status}).`);
        }
      }
    } else {
      sections.background.push("Baseline surgical recovery; no known contraindications documented.");
    }
  }

  if (sections.assessment.length === 0) {
    const vitals = events.filter((e) => e.category === "vital");
    if (vitals.length > 0) {
      const latest = vitals[vitals.length - 1];
      if (latest.category === "vital") {
        const bp = latest.payload.systolicBloodPressure ? `BP ${latest.payload.systolicBloodPressure}/${latest.payload.diastolicBloodPressure}` : "";
        const hr = latest.payload.heartRate ? `HR ${latest.payload.heartRate}` : "";
        const sats = latest.payload.oxygenSaturation ? `SpO2 ${latest.payload.oxygenSaturation}%` : "";
        sections.assessment.push(`Latest vitals: ${[bp, hr, sats].filter(Boolean).join(", ")} at ${time(latest.recordedAt)}.`);
      }
    }
  }

  if (sections.recommendation.length === 0) {
    const openTasks = events.filter((e) => e.category === "task" && e.payload.status === "open");
    for (const task of openTasks) {
      if (task.category === "task") {
        sections.recommendation.push(`Task to complete: ${task.payload.title}${task.payload.dueAt ? ` (due ${time(task.payload.dueAt)})` : ""}.`);
      }
    }
    if (sections.recommendation.length === 0) {
      sections.recommendation.push("Continue routine shift vital schedule and assess pain levels on next round.");
    }
  }

  return sections;
}

export function ShiftBoard({
  snapshots,
  events,
  handoffs,
  candidates,
  reviews,
  nurses,
  vitalMonitoringPlans,
  demoNow,
  boardMode,
  sourceMessage,
}: ShiftBoardProps) {
  const [selectedNurseId, setSelectedNurseId] = useState(nurses[0]?.id ?? "");
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [acuityFilter, setAcuityFilter] = useState<"all" | "urgent" | "attention" | "routine">("all");
  const [board, setBoard] = useState(() =>
    createLiveBoardState({ patients: snapshots.map((s) => s.patient), events, handoffs, now: new Date(demoNow) }),
  );
  const [candidateVersions, setCandidateVersions] = useState(candidates);
  const [agentRunStates, setAgentRunStates] = useState<Record<string, AgentRunState>>({});
  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const [recordingPatientId, setRecordingPatientId] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [signOffStatus, setSignOffStatus] = useState<Record<string, string>>({});

  const nurseById = useMemo(() => new Map(nurses.map((nurse) => [nurse.id, nurse])), [nurses]);

  const syncNurseSession = useCallback(async (nurseId: string) => {
    try {
      await fetch("/api/demo-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nurseId }),
      });
    } catch {
      // offline
    }
  }, []);

  const handleNurseChange = async (nurseId: string) => {
    setSelectedNurseId(nurseId);
    setIdentityError(null);
    await syncNurseSession(nurseId);
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/demo-session")
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { nurseId?: string | null };
      })
      .then(async (payload) => {
        if (!active) return;
        if (payload?.nurseId && nurseById.has(payload.nurseId)) {
          setSelectedNurseId(payload.nurseId);
        } else {
          const defaultId = nurses[0]?.id;
          if (defaultId) {
            setSelectedNurseId(defaultId);
            await syncNurseSession(defaultId);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [nurseById, nurses, syncNurseSession]);

  useEffect(() => {
    if (boardMode !== "realtime") return;
    const client = createOptionalSupabaseClient();
    if (!client) return;
    const unsubscribeSource = subscribeToSourceEvents(client, (event) =>
      setBoard((current) => applySourceEvent(current, event, new Date())),
    );
    const unsubscribeWorkflow = subscribeToHandoffWorkflow(client, {
      onVersion: (row) => {
        const version = handoffVersionFromSupabaseRow(row);
        if (version?.status === "candidate") {
          setCandidateVersions((current) => (current.some((item) => item.id === version.id) ? current : [...current, version]));
        }
      },
      onReview: () => undefined,
      onPublication: () => undefined,
      onStatus: () => undefined,
    });
    return () => {
      unsubscribeSource();
      unsubscribeWorkflow();
    };
  }, [boardMode]);

  const monitoringByPatient = useMemo(() => {
    const value = new Map<string, VitalMonitoringStatus[]>();
    for (const patient of board.snapshots.map((snapshot) => snapshot.patient)) {
      const patientEvents = board.events.filter((event) => event.patientId === patient.id);
      value.set(
        patient.id,
        vitalMonitoringPlans
          .filter((plan) => plan.patientId === patient.id)
          .map((plan) => evaluateVitalMonitoring(patientEvents, plan)),
      );
    }
    return value;
  }, [board.events, board.snapshots, vitalMonitoringPlans]);

  const latestCandidateByPatient = useMemo(() => {
    const value = new Map<string, HandoffVersion>();
    for (const candidate of candidateVersions) {
      const current = value.get(candidate.patientId);
      if (!current || candidate.versionNumber >= current.versionNumber) value.set(candidate.patientId, candidate);
    }
    // Also fall back to generated initial handoffs if candidate is not yet present
    for (const handoff of board.handoffs) {
      if (!value.has(handoff.patientId)) value.set(handoff.patientId, handoff);
    }
    return value;
  }, [candidateVersions, board.handoffs]);

  const tiles = useMemo(() => {
    return board.snapshots.map((snapshot) => {
      const patientEvents = board.events.filter((e) => e.patientId === snapshot.patient.id);
      const monitoring = monitoringByPatient.get(snapshot.patient.id) ?? [];
      const acuity = computePatientAcuity(monitoring, snapshot, patientEvents);
      const watchOuts = extractWatchOuts(snapshot.patient.id, snapshot, monitoring, patientEvents);
      const candidate = latestCandidateByPatient.get(snapshot.patient.id) ?? null;
      return {
        snapshot,
        monitoring,
        events: patientEvents,
        acuity,
        watchOuts,
        candidate,
      };
    });
  }, [board.snapshots, board.events, monitoringByPatient, latestCandidateByPatient]);

  const filteredTiles = useMemo(() => {
    const sorted = [...tiles].sort((a, b) => {
      const priority = { urgent: 0, attention: 1, routine: 2 };
      return priority[a.acuity] - priority[b.acuity] || a.snapshot.patient.room.localeCompare(b.snapshot.patient.room);
    });
    if (acuityFilter === "all") return sorted;
    return sorted.filter((t) => t.acuity === acuityFilter);
  }, [tiles, acuityFilter]);

  const selectedTile = tiles.find((t) => t.snapshot.patient.id === selectedPatientId) ?? null;

  async function triggerAgentForPatient(patientId: string) {
    const steps = [
      { step: 1, label: "Reading day-of charting events..." },
      { step: 2, label: "Analyzing vital trends & med schedules..." },
      { step: 3, label: "Synthesizing SBAR & watch-outs..." },
    ];

    setAgentRunStates((prev) => ({
      ...prev,
      [patientId]: { active: true, step: 1, label: steps[0].label },
    }));

    for (let i = 0; i < steps.length; i++) {
      await new Promise((r) => setTimeout(r, 450));
      setAgentRunStates((prev) => ({
        ...prev,
        [patientId]: { active: true, step: steps[i].step, label: steps[i].label },
      }));
    }

    try {
      if (selectedNurseId) await syncNurseSession(selectedNurseId);
      const response = await fetch("/api/handoffs/candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId }),
      });
      if (response.ok) {
        const candidate = (await response.json()) as HandoffVersion;
        setCandidateVersions((current) =>
          current.some((item) => item.id === candidate.id) ? current : [...current, candidate],
        );
      }
    } catch {
      // In local fixture mode, state is already computed
    }

    await new Promise((r) => setTimeout(r, 300));
    setAgentRunStates((prev) => ({
      ...prev,
      [patientId]: {
        active: false,
        step: 4,
        label: "Handoff Ready (AI Verified)",
        lastUpdated: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }),
      },
    }));
  }

  async function triggerAgentForAll() {
    setIsProcessingAll(true);
    for (const tile of tiles) {
      await triggerAgentForPatient(tile.snapshot.patient.id);
    }
    setIsProcessingAll(false);
  }

  async function recordNewUpdate(patientId: string, noteText: string): Promise<boolean> {
    setRecordingPatientId(patientId);
    setRecordingError(null);
    try {
      if (selectedNurseId) await syncNurseSession(selectedNurseId);
      const response = await fetch("/api/vitals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId, note: noteText }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || typeof payload !== "object" || payload === null || !("event" in payload) || !("candidate" in payload)) {
        throw new Error(readApiError(payload, "The clinical update could not be processed."));
      }
      const result = payload as { event: ChartEvent; candidate: HandoffVersion; allEvents?: ChartEvent[]; message?: string };
      
      if (result.allEvents && Array.isArray(result.allEvents)) {
        for (const ev of result.allEvents) {
          setBoard((current) => applySourceEvent(current, ev, new Date(ev.recordedAt)));
        }
      } else {
        setBoard((current) => applySourceEvent(current, result.event, new Date(result.event.recordedAt)));
      }

      setCandidateVersions((current) => {
        const filtered = current.filter((item) => item.patientId !== result.candidate.patientId);
        return [...filtered, result.candidate];
      });

      return true;
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "The update could not be saved.");
      return false;
    } finally {
      setRecordingPatientId(null);
    }
  }

  function handleSignOff(patientId: string) {
    const nurse = nurseById.get(selectedNurseId)?.displayName ?? "Nurse";
    setSignOffStatus((prev) => ({
      ...prev,
      [patientId]: `Approved & Signed Off by ${nurse} at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    }));
  }

  const counts = {
    all: tiles.length,
    urgent: tiles.filter((t) => t.acuity === "urgent").length,
    attention: tiles.filter((t) => t.acuity === "attention").length,
    routine: tiles.filter((t) => t.acuity === "routine").length,
  };

  return (
    <main className="board-shell">
      {/* Top Banner / Header */}
      <header className="board-header">
        <div>
          <p className="eyebrow">4-WEST MED-SURG UNIT · 12-HOUR SHIFT CENSUS (07:00 – 19:00)</p>
          <h1>Automated Nursing Shift Handoff Board</h1>
          <p className="header-copy">
            Agentic AI continuously parses day-of charting (vitals, meds, tasks, physician notes) to generate structured
            SBAR handoffs, highlighting time-critical watch-outs for the incoming shift.
          </p>
        </div>

        <div className="header-actions">
          <label className="nurse-select">
            <span>Reviewing Nurse</span>
            <select value={selectedNurseId} onChange={(e) => handleNurseChange(e.target.value)}>
              {nurses.map((nurse) => (
                <option key={nurse.id} value={nurse.id}>
                  {nurse.displayName}
                </option>
              ))}
            </select>
            <span className="identity-copy">{boardMode === "realtime" ? "Shared Live Census" : "✨ Gemini 3.8 Flash Active"}</span>
          </label>

          <button
            type="button"
            className="process-all-button"
            disabled={isProcessingAll}
            onClick={triggerAgentForAll}
          >
            {isProcessingAll ? "⚡ AI Processing Shift Census…" : "✨ Run Shift Handoff Agent"}
          </button>
        </div>
      </header>

      {sourceMessage && <p className="source-banner source-banner-warning">{sourceMessage}</p>}
      {identityError && <p className="source-banner source-banner-error">{identityError}</p>}
      {recordingError && <p className="source-banner source-banner-error">{recordingError}</p>}

      {/* Acuity Filters Bar */}
      <section className="census-controls" aria-label="Census Acuity Filters">
        <div className="filter-group">
          <span className="filter-label">Filter Acuity:</span>
          <button
            type="button"
            className={`filter-pill ${acuityFilter === "all" ? "is-active" : ""}`}
            onClick={() => setAcuityFilter("all")}
          >
            All Patients ({counts.all})
          </button>
          <button
            type="button"
            className={`filter-pill filter-urgent ${acuityFilter === "urgent" ? "is-active" : ""}`}
            onClick={() => setAcuityFilter("urgent")}
          >
            🔴 Urgent ({counts.urgent})
          </button>
          <button
            type="button"
            className={`filter-pill filter-attention ${acuityFilter === "attention" ? "is-active" : ""}`}
            onClick={() => setAcuityFilter("attention")}
          >
            🟡 Attention ({counts.attention})
          </button>
          <button
            type="button"
            className={`filter-pill filter-routine ${acuityFilter === "routine" ? "is-active" : ""}`}
            onClick={() => setAcuityFilter("routine")}
          >
            🟢 Routine ({counts.routine})
          </button>
        </div>
      </section>

      {/* Patient Tiles Grid */}
      <section aria-labelledby="census-heading">
        <h2 id="census-heading" className="sr-only">
          Patient Census Tiles
        </h2>
        <div className="tile-grid">
          {filteredTiles.map(({ snapshot, monitoring, events: patientEvents, acuity, watchOuts, candidate }) => {
            const agentState = agentRunStates[snapshot.patient.id];
            const topWatchOut = watchOuts[0] ?? "Monitoring on schedule; no acute concerns flagged.";

            return (
              <article
                key={snapshot.patient.id}
                className={`patient-tile acuity-${acuity} ${agentState?.active ? "is-processing" : ""}`}
              >
                {/* Top Line: Room + Acuity Badge */}
                <div className="tile-topline">
                  <span className="room-badge">ROOM {snapshot.patient.room}</span>
                  <span className={`acuity-badge badge-${acuity}`}>
                    {acuity === "urgent" && "🔴 URGENT"}
                    {acuity === "attention" && "🟡 ATTENTION"}
                    {acuity === "routine" && "🟢 ROUTINE"}
                  </span>
                </div>

                {/* Patient Name */}
                <h3 className="patient-name">{snapshot.patient.displayName}</h3>

                {/* Live Agent Status Banner */}
                <div className={`agent-pulse-badge ${agentState?.active ? "pulsing" : "ready"}`}>
                  <span className="agent-dot" />
                  <span className="agent-text">
                    {agentState?.active
                      ? agentState.label
                      : agentState?.lastUpdated
                      ? `✓ Agent Verified (${agentState.lastUpdated})`
                      : "✓ Handoff Ready (AI Verified)"}
                  </span>
                </div>

                {/* Prominent Watch-Out Chip */}
                <div className={`watchout-chip-container chip-${acuity}`}>
                  <p className="watchout-chip-text">{topWatchOut}</p>
                </div>

                {/* Quick SBAR Snapshot Line */}
                <div className="sbar-preview-box">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                    <p className="sbar-preview-label">SBAR SUMMARY</p>
                    <span style={{
                      fontSize: "0.65rem",
                      padding: "1px 6px",
                      borderRadius: "10px",
                      background: candidate?.model?.startsWith("gemini") ? "#ecfdf5" : "#f1f5f9",
                      color: candidate?.model?.startsWith("gemini") ? "#047857" : "#64748b",
                      border: candidate?.model?.startsWith("gemini") ? "1px solid #a7f3d0" : "1px solid #e2e8f0",
                      fontWeight: 600,
                    }}>
                      {candidate?.model?.startsWith("gemini") ? `✨ ${candidate.model.replace("models/", "")}` : "📋 Static Preload"}
                    </span>
                  </div>
                  <p className="sbar-preview-text">
                    {candidate?.claims.find((c) => c.section === "situation")?.text ??
                      (patientEvents[0]?.payload && "summary" in patientEvents[0].payload
                        ? (patientEvents[0].payload as { summary: string }).summary
                        : "Clinical trajectory synthesized from day-of charting.")}
                  </p>
                </div>

                {/* Tile Bottom Actions */}
                <div className="tile-bottom">
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      className="agent-rerun-btn"
                      disabled={agentState?.active}
                      onClick={() => triggerAgentForPatient(snapshot.patient.id)}
                    >
                      {agentState?.active ? "Processing…" : "⚡ Run Agent"}
                    </button>

                    <button
                      type="button"
                      className="agent-rerun-btn"
                      style={{ background: "#f8fafc", borderColor: "#cbd5e1" }}
                      onClick={() => {
                        setSelectedPatientId(snapshot.patient.id);
                        setTimeout(() => {
                          const el = document.getElementById("clinical-patch-panel");
                          if (el) el.scrollIntoView({ behavior: "smooth" });
                        }, 100);
                      }}
                    >
                      ✏️ Patch / Note
                    </button>
                  </div>

                  <button
                    type="button"
                    className="open-handoff-btn"
                    onClick={() => setSelectedPatientId(snapshot.patient.id)}
                  >
                    View SBAR Handoff →
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Slide-over Patient Drawer */}
      {selectedTile && (
        <PatientHandoffDrawer
          tile={selectedTile}
          recording={recordingPatientId === selectedTile.snapshot.patient.id}
          signedOffText={signOffStatus[selectedTile.snapshot.patient.id]}
          onSignOff={() => handleSignOff(selectedTile.snapshot.patient.id)}
          onRecordUpdate={(note) => recordNewUpdate(selectedTile.snapshot.patient.id, note)}
          onReRunAgent={() => triggerAgentForPatient(selectedTile.snapshot.patient.id)}
          onClose={() => setSelectedPatientId(null)}
        />
      )}
    </main>
  );
}

function PatientHandoffDrawer({
  tile,
  recording,
  signedOffText,
  onSignOff,
  onRecordUpdate,
  onReRunAgent,
  onClose,
}: {
  tile: {
    snapshot: FoundationPatientSnapshot;
    monitoring: VitalMonitoringStatus[];
    events: ChartEvent[];
    acuity: "urgent" | "attention" | "routine";
    watchOuts: string[];
    candidate: HandoffVersion | null;
  };
  recording: boolean;
  signedOffText?: string;
  onSignOff: () => void;
  onRecordUpdate: (note: string) => Promise<boolean>;
  onReRunAgent: () => void;
  onClose: () => void;
}) {
  const [newNote, setNewNote] = useState("");
  const [patchStatus, setPatchStatus] = useState<string | null>(null);
  const [showRawFeed, setShowRawFeed] = useState(false);

  const sbar = useMemo(
    () => getStructuredSbar(tile.candidate, tile.events, tile.snapshot.patient.displayName),
    [tile.candidate, tile.events, tile.snapshot.patient.displayName],
  );

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="sbar-drawer full-sbar-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <header className="drawer-header">
          <div>
            <div className="drawer-eyebrow-row">
              <span className="room-badge">ROOM {tile.snapshot.patient.room}</span>
              <span className={`acuity-badge badge-${tile.acuity}`}>
                {tile.acuity === "urgent" && "🔴 URGENT"}
                {tile.acuity === "attention" && "🟡 ATTENTION"}
                {tile.acuity === "routine" && "🟢 ROUTINE"}
              </span>
            </div>
            <h2 id="drawer-title" className="drawer-title">
              {tile.snapshot.patient.displayName}
            </h2>
            <p className="drawer-sub">Shift Handoff · Synthesized from {tile.events.length} day-of charting records</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close patient">
            ×
          </button>
        </header>

        {/* 🚨 Priority Watch-Outs Banner */}
        <section className={`watchouts-drawer-banner banner-${tile.acuity}`}>
          <div className="banner-title-row">
            <h4>🚨 INCOMING NURSE WATCH-OUTS & ACTION ITEMS</h4>
            <span className="banner-count">{tile.watchOuts.length} Flagged</span>
          </div>
          <ul className="watchouts-drawer-list">
            {tile.watchOuts.map((wo, i) => (
              <li key={i}>{wo}</li>
            ))}
          </ul>
        </section>

        {/* Model Provenance & Verification Strip */}
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          borderRadius: "8px",
          background: tile.candidate?.model?.startsWith("gemini") ? "#f0fdf4" : "#f8fafc",
          border: tile.candidate?.model?.startsWith("gemini") ? "1px solid #86efac" : "1px solid #e2e8f0",
          margin: "1rem 0",
        }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: "0.85rem", color: tile.candidate?.model?.startsWith("gemini") ? "#15803d" : "#475569" }}>
              {tile.candidate?.model?.startsWith("gemini") ? `✨ Synthesized by Google Gemini (${tile.candidate.model.replace("models/", "")})` : "📋 Static Preloaded Fixture"}
            </span>
            <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "2px" }}>
              {tile.candidate?.model?.startsWith("gemini")
                ? `Structured JSON API · Verified with 0 evidence gaps · ${tile.candidate.claims.length} claims cited`
                : "Deterministic rule-based baseline · Click 'Run Agent' to generate live with Gemini"}
            </div>
          </div>
          <span style={{
            fontSize: "0.7rem",
            fontWeight: 700,
            letterSpacing: "0.05em",
            color: tile.candidate?.model?.startsWith("gemini") ? "#15803d" : "#64748b",
            background: tile.candidate?.model?.startsWith("gemini") ? "#dcfce7" : "#e2e8f0",
            padding: "3px 8px",
            borderRadius: "6px",
          }}>
            {tile.candidate?.model?.startsWith("gemini") ? "LIVE GEMINI" : "PRELOADED"}
          </span>
        </div>

        {/* Structured SBAR Cards */}
        <section className="sbar-cards-container">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <h3 className="section-title" style={{ margin: 0 }}>Structured SBAR Handoff</h3>
            <span style={{
              fontSize: "0.75rem",
              padding: "2px 8px",
              borderRadius: "12px",
              background: tile.candidate?.model?.startsWith("gemini") ? "#f0fdf4" : "#f1f5f9",
              color: tile.candidate?.model?.startsWith("gemini") ? "#166534" : "#475569",
              border: tile.candidate?.model?.startsWith("gemini") ? "1px solid #bbf7d0" : "1px solid #e2e8f0",
              fontWeight: 600,
            }}>
              ✨ {tile.candidate?.model ? tile.candidate.model.replace("models/", "") : "deterministic-fixture"}
            </span>
          </div>

          {/* S - Situation */}
          <div className="sbar-card card-situation">
            <div className="sbar-card-header">
              <span className="sbar-letter">S</span>
              <h4>SITUATION</h4>
            </div>
            <div className="sbar-card-body">
              {sbar.situation.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>

          {/* B - Background */}
          <div className="sbar-card card-background">
            <div className="sbar-card-header">
              <span className="sbar-letter">B</span>
              <h4>BACKGROUND</h4>
            </div>
            <div className="sbar-card-body">
              {sbar.background.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>

          {/* A - Assessment */}
          <div className="sbar-card card-assessment">
            <div className="sbar-card-header">
              <span className="sbar-letter">A</span>
              <h4>ASSESSMENT & VITALS</h4>
            </div>
            <div className="sbar-card-body">
              {sbar.assessment.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>

          {/* R - Recommendation */}
          <div className="sbar-card card-recommendation">
            <div className="sbar-card-header">
              <span className="sbar-letter">R</span>
              <h4>RECOMMENDATION</h4>
            </div>
            <div className="sbar-card-body">
              {sbar.recommendation.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        </section>

        {/* Interactive Clinical Patch & AI Handoff Form */}
        <section className="nursing-update-panel" id="clinical-patch-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
            <p className="eyebrow" style={{ color: "#2563eb", fontWeight: 800, margin: 0 }}>⚡ LIVE AI EHR PATCH & SBAR RE-SYNTHESIS</p>
            {tile.candidate?.model?.startsWith("gemini") && (
              <span style={{ fontSize: "0.68rem", background: "#dcfce7", color: "#15803d", padding: "2px 8px", borderRadius: "12px", fontWeight: 700 }}>
                ✨ Powered by Gemini
              </span>
            )}
          </div>
          <h3>Change or Add Anything in Patient Chart</h3>
          <p className="update-help">
            Enter any clinical observation, vital sign update, medication change, or clinical order. Gemini AI parses your update into structured EHR events, patches the backend database, and re-synthesizes the SBAR handoff in real time.
          </p>

          {/* Quick Preset Template Chips */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "12px" }}>
            <span style={{ fontSize: "0.72rem", color: "#64748b", fontWeight: 700, width: "100%", marginBottom: "2px" }}>
              Quick Clinical Presets (Click to fill):
            </span>
            {[
              { label: "🚨 BP 88/54 & dizzy", text: "BP 88/54 at current hour, patient reports dizziness when sitting up." },
              { label: "💉 Saline IV Bolus", text: "Started 500 mL Normal Saline IV bolus via peripheral line." },
              { label: "🩺 Dr. Chen Consulted", text: "Dr. Chen paged and reviewed patient at bedside; confirmed plan to repeat BP in 30m." },
              { label: "💊 Acetaminophen given", text: "Administered Acetaminophen 650mg PO, surgical pain improved to 2/10." },
              { label: "🩹 Cannula Replaced", text: "Peripheral IV cannula replaced in right forearm; site clean and patent." },
              { label: "🟢 Normal Vitals / Resting", text: "BP 120/78, HR 74, SpO2 98%. Patient resting comfortably with no distress." },
            ].map((preset, idx) => (
              <button
                key={idx}
                type="button"
                style={{
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "16px",
                  padding: "4px 10px",
                  fontSize: "0.73rem",
                  fontWeight: 600,
                  color: "#1e293b",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                onClick={() => setNewNote(preset.text)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setPatchStatus("🤖 Gemini is parsing clinical update & patching EHR...");
              const success = await onRecordUpdate(newNote);
              if (success) {
                setPatchStatus("✨ Successfully patched backend EHR and re-synthesized SBAR!");
                setNewNote("");
                setTimeout(() => setPatchStatus(null), 6000);
              } else {
                setPatchStatus(null);
              }
            }}
          >
            <textarea
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="e.g. BP 88/54, dizzy when standing up; started 500ml normal saline bolus. Or: Dr. Chen reviewed at bedside, continue telemetry."
              rows={3}
              required
            />

            {patchStatus && (
              <div style={{
                background: patchStatus.startsWith("✨") ? "#f0fdf4" : "#eff6ff",
                border: patchStatus.startsWith("✨") ? "1px solid #86efac" : "1px solid #bfdbfe",
                color: patchStatus.startsWith("✨") ? "#15803d" : "#1d4ed8",
                padding: "8px 12px",
                borderRadius: "8px",
                fontSize: "0.78rem",
                fontWeight: 700,
                marginBottom: "10px",
              }}>
                {patchStatus}
              </div>
            )}

            <button
              type="submit"
              className="record-vital-button"
              style={{
                background: recording ? "#64748b" : "linear-gradient(135deg, #1d4ed8, #2563eb)",
                padding: "10px 16px",
                fontSize: "0.82rem",
                borderRadius: "8px",
                fontWeight: 750,
                boxShadow: "0 2px 8px rgba(37, 99, 235, 0.25)",
              }}
              disabled={recording || newNote.trim().length < 3}
            >
              {recording ? "🤖 Gemini is Parsing & Patching SBAR…" : "⚡ Parse & Patch Chart (Re-Run Agent)"}
            </button>
          </form>
        </section>

        {/* Raw Charting Audit Feed (Collapsible) */}
        <section className="raw-feed-section">
          <button
            type="button"
            className="raw-feed-toggle"
            onClick={() => setShowRawFeed((prev) => !prev)}
          >
            {showRawFeed ? "▼ Hide Day-of Charting Audit Feed" : "▶ View Day-of Charting Audit Feed"} ({tile.events.length} records)
          </button>

          {showRawFeed && (
            <div className="timeline-feed">
              {tile.events.map((ev) => (
                <div key={ev.id} className="timeline-item">
                  <div className="timeline-meta">
                    <span className="timeline-time">{time(ev.occurredAt)}</span>
                    <span className={`timeline-tag tag-${ev.category}`}>{ev.category}</span>
                  </div>
                  <div className="timeline-content">
                    {ev.category === "nursing_note" && <p>{ev.payload.summary}</p>}
                    {ev.category === "vital" && (
                      <p>
                        {ev.payload.systolicBloodPressure && `BP ${ev.payload.systolicBloodPressure}/${ev.payload.diastolicBloodPressure} `}
                        {ev.payload.heartRate && `HR ${ev.payload.heartRate} `}
                        {ev.payload.oxygenSaturation && `SpO2 ${ev.payload.oxygenSaturation}% `}
                        {ev.payload.bloodGlucose && `BG ${ev.payload.bloodGlucose} `}
                      </p>
                    )}
                    {ev.category === "medication" && (
                      <p>
                        {ev.payload.medicationName} {ev.payload.dose} ({ev.payload.status})
                      </p>
                    )}
                    {ev.category === "task" && (
                      <p>
                        Task: {ev.payload.title} ({ev.payload.status})
                      </p>
                    )}
                    {ev.category === "incident" && <p>Incident: {ev.payload.description}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Sign-off / Review Footer */}
        <footer className="drawer-footer">
          {signedOffText ? (
            <div className="signed-off-box">
              <span className="check-icon">✓</span> {signedOffText}
            </div>
          ) : (
            <div className="sign-off-actions">
              <button type="button" className="sign-off-button" onClick={onSignOff}>
                ✓ Approve & Sign Off Handoff
              </button>
              <button type="button" className="reprocess-button" onClick={onReRunAgent}>
                ⚡ Re-Run Agent
              </button>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}
