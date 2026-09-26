"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChartEvent, HandoffVersion, VitalMonitoringPlan } from "@/lib/contracts";
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
  nurses: DemoNurse[];
  vitalMonitoringPlans: VitalMonitoringPlan[];
  demoNow: string;
  boardMode: BoardMode;
  sourceMessage?: string;
};

function readApiError(payload: unknown, fallback: string): string {
  return typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : fallback;
}

function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "not yet recorded";
}

function attentionLabel(attention: VitalMonitoringStatus["attention"]): string {
  if (attention === "urgent") return "Synthetic urgent-review flag";
  if (attention === "attention") return "Synthetic attention flag";
  return "Monitoring on schedule";
}

function monitoringPriority(status: VitalMonitoringStatus): number {
  if (status.attention === "urgent") return 0;
  if (status.attention === "attention") return 1;
  return 2;
}

function nextHandoffLine(status: VitalMonitoringStatus): string {
  const label = vitalLabel(status.plan.vitalType);
  if (!status.displayValue) return `${label} has not been recorded. Record the first reading for this monitoring plan.`;
  const flag = status.attention === "routine" ? "" : ` ${attentionLabel(status.attention)}.`;
  return `Latest ${label}: ${status.displayValue} at ${time(status.latestEvent?.recordedAt)}. Next ${label} check: ${time(status.nextDueAt)}.${flag}`;
}

export function ShiftBoard({ snapshots, events, handoffs, candidates, nurses, vitalMonitoringPlans, demoNow, boardMode, sourceMessage }: ShiftBoardProps) {
  const [selectedNurseId, setSelectedNurseId] = useState(nurses[0]?.id ?? "");
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [board, setBoard] = useState(() => createLiveBoardState({ patients: snapshots.map((snapshot) => snapshot.patient), events, handoffs, now: new Date(demoNow) }));
  const [candidateVersions, setCandidateVersions] = useState(candidates);
  const [sourceStatus, setSourceStatus] = useState<"fixture" | "connecting" | "live" | "error">(boardMode === "realtime" ? "connecting" : "fixture");
  const [recordingPatientId, setRecordingPatientId] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);

  const nurseById = useMemo(() => new Map(nurses.map((nurse) => [nurse.id, nurse])), [nurses]);

  useEffect(() => {
    if (boardMode === "fixture") return;
    let active = true;
    void fetch("/api/demo-session")
      .then(async (response) => ({ response, payload: await response.json() as { nurseId?: string | null; error?: string } }))
      .then(({ response, payload }) => {
        if (!active) return;
        if (!response.ok) setIdentityError(readApiError(payload, "Controlled demo identity is unavailable."));
        else if (payload.nurseId && nurseById.has(payload.nurseId)) setSelectedNurseId(payload.nurseId);
      })
      .catch(() => { if (active) setIdentityError("Controlled demo identity is unavailable."); });
    return () => { active = false; };
  }, [boardMode, nurseById]);

  useEffect(() => {
    if (boardMode !== "realtime") return;
    const client = createOptionalSupabaseClient();
    if (!client) {
      setSourceStatus("error");
      return;
    }
    const unsubscribeSource = subscribeToSourceEvents(client, (event) => setBoard((current) => applySourceEvent(current, event, new Date())), (status) => setSourceStatus(status === "connected" ? "live" : "error"));
    const unsubscribeWorkflow = subscribeToHandoffWorkflow(client, {
      onVersion: (row) => {
        const version = handoffVersionFromSupabaseRow(row);
        if (version?.status === "candidate") setCandidateVersions((current) => current.some((item) => item.id === version.id) ? current : [...current, version]);
      },
      onReview: () => undefined,
      onPublication: () => undefined,
      onStatus: (status) => { if (status === "error") setSourceStatus("error"); },
    });
    return () => { unsubscribeSource(); unsubscribeWorkflow(); };
  }, [boardMode]);

  const monitoringByPatient = useMemo(() => {
    const value = new Map<string, VitalMonitoringStatus[]>();
    for (const patient of board.snapshots.map((snapshot) => snapshot.patient)) {
      const patientEvents = board.events.filter((event) => event.patientId === patient.id);
      value.set(patient.id, vitalMonitoringPlans.filter((plan) => plan.patientId === patient.id).map((plan) => evaluateVitalMonitoring(patientEvents, plan)));
    }
    return value;
  }, [board.events, board.snapshots, vitalMonitoringPlans]);

  const latestCandidateByPatient = useMemo(() => {
    const value = new Map<string, HandoffVersion>();
    for (const candidate of candidateVersions) {
      const current = value.get(candidate.patientId);
      if (!current || candidate.versionNumber > current.versionNumber) value.set(candidate.patientId, candidate);
    }
    return value;
  }, [candidateVersions]);

  const tiles = useMemo(() => board.snapshots
    .map((snapshot) => ({ snapshot, monitoring: monitoringByPatient.get(snapshot.patient.id) ?? [] }))
    .sort((left, right) => {
      const leftPrimary = [...left.monitoring].sort((a, b) => monitoringPriority(a) - monitoringPriority(b) || new Date(a.nextDueAt ?? 0).getTime() - new Date(b.nextDueAt ?? 0).getTime())[0];
      const rightPrimary = [...right.monitoring].sort((a, b) => monitoringPriority(a) - monitoringPriority(b) || new Date(a.nextDueAt ?? 0).getTime() - new Date(b.nextDueAt ?? 0).getTime())[0];
      const fallback = { attention: "routine" } as VitalMonitoringStatus;
      return monitoringPriority(leftPrimary ?? fallback) - monitoringPriority(rightPrimary ?? fallback) || left.snapshot.patient.room.localeCompare(right.snapshot.patient.room);
    }), [board.snapshots, monitoringByPatient]);

  const selected = tiles.find((tile) => tile.snapshot.patient.id === selectedPatientId) ?? null;

  async function selectNurse(nurseId: string) {
    setSelectedNurseId(nurseId);
    if (boardMode === "fixture") return;
    setIdentityError(null);
    try {
      const response = await fetch("/api/demo-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nurseId }) });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readApiError(payload, "The selected nurse could not be activated."));
    } catch (error) {
      setIdentityError(error instanceof Error ? error.message : "The selected nurse could not be activated.");
    }
  }

  async function recordComment(patientId: string, note: string): Promise<boolean> {
    setRecordingPatientId(patientId);
    setRecordingError(null);
    try {
      const response = await fetch("/api/vitals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId, note }) });
      const payload: unknown = await response.json();
      if (!response.ok || typeof payload !== "object" || payload === null || !("event" in payload) || !("candidate" in payload)) {
        throw new Error(readApiError(payload, "The vital update could not be processed."));
      }
      const result = payload as { event: ChartEvent; candidate: HandoffVersion };
      setBoard((current) => applySourceEvent(current, result.event, new Date(result.event.recordedAt)));
      setCandidateVersions((current) => current.some((item) => item.id === result.candidate.id) ? current : [...current, result.candidate]);
      return true;
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "The vital update could not be processed.");
      return false;
    } finally {
      setRecordingPatientId(null);
    }
  }

  return <main className="board-shell vital-board-shell">
    <header className="board-header compact-header">
      <div><p className="eyebrow">SYNTHETIC VITAL-MONITORING DEMO</p><h1>Vital Handoff Board</h1><p className="header-copy">Record a nursing update. The handoff stays current for the next nurse.</p></div>
      <label className="nurse-select"><span>Current nurse</span><select value={selectedNurseId} onChange={(event) => { void selectNurse(event.target.value); }}>{nurses.map((nurse) => <option key={nurse.id} value={nurse.id}>{nurse.displayName}</option>)}</select><span className="identity-copy">{sourceStatus === "live" ? "Shared synthetic board" : "Local synthetic demo"}</span></label>
    </header>
    {sourceMessage && <p className="source-banner source-banner-warning" role="status">{sourceMessage}</p>}
    {identityError && <p className="source-banner source-banner-error" role="alert">{identityError}</p>}
    {recordingError && <p className="source-banner source-banner-error" role="alert">{recordingError}</p>}
    <section aria-labelledby="board-heading"><div className="section-heading"><div><p className="eyebrow">4 WEST · SHIFT CENSUS</p><h2 id="board-heading">Patients</h2></div></div><div className="tile-grid">{tiles.map(({ snapshot, monitoring }) => <PatientTile key={snapshot.patient.id} snapshot={snapshot} monitoring={monitoring} onOpen={() => setSelectedPatientId(snapshot.patient.id)} />)}</div></section>
    {selected && <PatientDrawer snapshot={selected.snapshot} monitoring={selected.monitoring} candidate={latestCandidateByPatient.get(selected.snapshot.patient.id) ?? null} recording={recordingPatientId === selected.snapshot.patient.id} onRecord={(note) => recordComment(selected.snapshot.patient.id, note)} onClose={() => setSelectedPatientId(null)} />}
  </main>;
}

function PatientTile({ snapshot, monitoring, onOpen }: { snapshot: FoundationPatientSnapshot; monitoring: VitalMonitoringStatus[]; onOpen: () => void }) {
  const primary = [...monitoring].sort((left, right) => monitoringPriority(left) - monitoringPriority(right) || new Date(left.nextDueAt ?? 0).getTime() - new Date(right.nextDueAt ?? 0).getTime())[0];
  return <article className={`patient-tile vital-tile monitoring-${primary?.attention ?? "routine"}`}><p className="room">ROOM {snapshot.patient.room}</p><h3>{snapshot.patient.displayName}</h3>{primary ? <><p className="vital-current"><strong>{vitalLabel(primary.plan.vitalType)}</strong> {primary.displayValue ?? "No recorded value"}</p><p className="vital-next">Next check: {time(primary.nextDueAt)}</p><p className="vital-state">{attentionLabel(primary.attention)}</p></> : <p className="no-actions">No active monitoring plan</p>}<button type="button" className="open-handoff" onClick={onOpen}>Open patient <span aria-hidden="true">→</span></button></article>;
}

function PatientDrawer({ snapshot, monitoring, candidate, recording, onRecord, onClose }: { snapshot: FoundationPatientSnapshot; monitoring: VitalMonitoringStatus[]; candidate: HandoffVersion | null; recording: boolean; onRecord: (note: string) => Promise<boolean>; onClose: () => void }) {
  const [note, setNote] = useState("");
  const handoffLines = candidate?.claims.filter((claim) => claim.id.startsWith("vital-monitoring:")).map((claim) => claim.text) ?? [];
  const displayedHandoff = handoffLines.length > 0 ? handoffLines : monitoring.map(nextHandoffLine);
  return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}><aside className="sbar-drawer vital-drawer" role="dialog" aria-modal="true" aria-labelledby="handoff-title" onMouseDown={(event) => event.stopPropagation()}>
    <header className="drawer-header"><div><p className="eyebrow">ROOM {snapshot.patient.room}</p><h2 id="handoff-title">{snapshot.patient.displayName}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close patient">×</button></header>
    <section className="drawer-section"><p className="eyebrow">CURRENT MONITORING</p><div className="monitoring-list">{monitoring.map((status) => <div key={status.plan.id} className={`monitoring-row monitoring-${status.attention}`}><strong>{vitalLabel(status.plan.vitalType)} {status.displayValue ?? "not recorded"}</strong><span>Recorded: {time(status.latestEvent?.recordedAt)}</span><span>Next check: {time(status.nextDueAt)}</span></div>)}</div></section>
    <section className="nursing-update"><p className="eyebrow">NURSING UPDATE</p><h3>What did you record?</h3><p>Write naturally. Example: <em>“BP 118/72 at 4 pm”</em> or <em>“SpO2 was 97% at 4:20 pm.”</em></p><form onSubmit={async (event) => { event.preventDefault(); if (await onRecord(note)) setNote(""); }}><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. BP recorded 118/72 at 4 pm" rows={4} required /><button className="record-vital-button" type="submit" disabled={recording || note.trim().length < 3}>{recording ? "Reading update…" : "Update handoff"}</button></form></section>
    <section className="handoff-output" aria-live="polite"><p className="eyebrow">NEXT NURSE HANDOFF</p><h3>{candidate ? "New handoff draft" : "Current handoff"}</h3>{displayedHandoff.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}<p className="agent-trail">Vital parsed → monitoring plan checked → handoff updated</p></section>
  </aside></div>;
}
