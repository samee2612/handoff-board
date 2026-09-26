"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActionAlert, ChartEvent, HandoffClaim, HandoffVersion } from "@/lib/contracts";
import type { DemoNurse } from "@/lib/demo/seed-data";
import type { FoundationPatientSnapshot } from "@/lib/engine/board";
import { coverageStatus, sortBoardTiles, type BoardTile, type TileReview } from "@/lib/board/priority";
import { applyCandidateVersion, applySourceEvent, createLiveBoardState, isHandoffStale } from "@/lib/board/live-board";
import { createOptionalSupabaseClient } from "@/lib/supabase/client";
import { subscribeToSourceEvents } from "@/lib/supabase/realtime";
import type { BoardMode } from "@/lib/supabase/board-data";

type ShiftBoardProps = {
  snapshots: FoundationPatientSnapshot[];
  events: ChartEvent[];
  handoffs: HandoffVersion[];
  nurses: DemoNurse[];
  demoNow: string;
  boardMode: BoardMode;
  sourceMessage?: string;
};

const sectionLabels = {
  situation: "Situation",
  background: "Background",
  assessment: "Assessment",
  recommendation: "Recommendation",
} as const;

function relativeDue(dueAt: string, now: string): string {
  const minutes = Math.round((new Date(dueAt).getTime() - new Date(now).getTime()) / 60_000);
  if (minutes < 0) return `${Math.abs(minutes)} min overdue`;
  if (minutes === 0) return "due now";
  return `due in ${minutes} min`;
}

function alertLabel(alert: ActionAlert, now: string): string {
  const kind = alert.kind === "eligible_prn" ? "PRN eligible" : alert.kind === "task" ? "Task" : "Medication";
  return `${kind}: ${alert.title} · ${relativeDue(alert.dueAt, now)}`;
}

function statusCopy(status: "green" | "amber" | "red") {
  if (status === "green") return { icon: "●", label: "Evidence and data current" };
  if (status === "amber") return { icon: "▲", label: "Evidence or data needs review" };
  return { icon: "!", label: "Missing evidence or required data" };
}

export function ShiftBoard({ snapshots, events, handoffs, nurses, demoNow, boardMode, sourceMessage }: ShiftBoardProps) {
  const [selectedNurseId, setSelectedNurseId] = useState(nurses[0]?.id ?? "");
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Record<string, TileReview>>({});
  const [draftNote, setDraftNote] = useState("");
  const [board, setBoard] = useState(() => createLiveBoardState({ patients: snapshots.map((snapshot) => snapshot.patient), events, handoffs, now: new Date(demoNow) }));
  const [sourceStatus, setSourceStatus] = useState<"fixture" | "connecting" | "live" | "error">(boardMode === "realtime" ? "connecting" : "fixture");
  const [refreshingPatientId, setRefreshingPatientId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const selectedNurse = nurses.find((nurse) => nurse.id === selectedNurseId) ?? nurses[0];

  useEffect(() => {
    if (boardMode !== "realtime") return;
    const client = createOptionalSupabaseClient();
    if (!client) {
      setSourceStatus("error");
      return;
    }
    return subscribeToSourceEvents(
      client,
      (event) => setBoard((current) => applySourceEvent(current, event, new Date())),
      (status) => setSourceStatus(status === "connected" ? "live" : "error"),
    );
  }, [boardMode]);

  const tiles = useMemo(() => {
    const versionByPatient = new Map(board.handoffs.map((handoff) => [handoff.patientId, handoff]));
    return sortBoardTiles(
      board.snapshots.flatMap((snapshot) => {
        const handoff = versionByPatient.get(snapshot.patient.id);
        return handoff ? [{ ...snapshot, handoff, review: reviews[snapshot.patient.id], stale: isHandoffStale(handoff, board.events) }] : [];
      }),
    );
  }, [board, reviews]);

  const selectedTile = tiles.find((tile) => tile.patient.id === selectedPatientId) ?? null;

  useEffect(() => {
    setDraftNote(selectedTile?.review?.note ?? "");
  }, [selectedTile?.patient.id, selectedTile?.review?.note]);

  function saveReview() {
    if (!selectedTile || !selectedNurse) return;
    setReviews((current) => ({
      ...current,
      [selectedTile.patient.id]: {
        nurseId: selectedNurse.id,
        nurseName: selectedNurse.displayName,
        note: draftNote.trim(),
        reviewedAt: new Date().toISOString(),
      },
    }));
  }

  async function refreshHandoff(patientId: string) {
    setRefreshingPatientId(patientId);
    setRefreshError(null);
    try {
      const response = await fetch("/api/handoffs/candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || typeof payload !== "object" || payload === null || !("id" in payload)) {
        const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
          ? payload.error : "Candidate generation failed. The previous handoff remains unchanged.";
        throw new Error(message);
      }
      setBoard((current) => applyCandidateVersion(current, payload as HandoffVersion));
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Candidate generation failed. The previous handoff remains unchanged.");
    } finally {
      setRefreshingPatientId(null);
    }
  }

  const staleCount = tiles.filter((tile) => tile.stale).length;

  return (
    <main className="board-shell">
      <header className="board-header">
        <div>
          <p className="eyebrow">SYNTHETIC DATA ONLY · DEMO UNIT</p>
          <h1>Shift Handoff Board</h1>
          <p className="header-copy">Prioritized handoffs with source-linked SBAR evidence. This is decision support, not clinical direction.</p>
          <p className={`source-state source-${sourceStatus}`} role="status">{sourceStatus === "live" ? "Live synthetic source events connected" : sourceStatus === "connecting" ? "Connecting to live synthetic source events…" : sourceStatus === "error" ? "Live source connection unavailable" : "Local synthetic fixture mode"}</p>
        </div>
        <label className="nurse-select">
          <span>Reviewing nurse</span>
          <select value={selectedNurseId} onChange={(event) => setSelectedNurseId(event.target.value)}>
            {nurses.map((nurse) => <option key={nurse.id} value={nurse.id}>{nurse.displayName}</option>)}
          </select>
        </label>
      </header>

      {sourceMessage && <p className="source-banner source-banner-warning" role="status">{sourceMessage}</p>}
      {staleCount > 0 && <p className="source-banner source-banner-stale" role="status" aria-live="polite">{staleCount} handoff{staleCount === 1 ? " has" : "s have"} newer source data. Refresh each affected handoff to create a candidate version.</p>}
      {refreshError && <p className="source-banner source-banner-error" role="alert">{refreshError}</p>}

      <section aria-labelledby="board-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">4 WEST · SHIFT CENSUS</p>
            <h2 id="board-heading">Patient handoffs</h2>
          </div>
          <p className="priority-key" aria-label="Priority order: overdue and imminent actions are shown first, followed by evidence status and review state.">Prioritized by action, evidence status, then review state</p>
        </div>
        <div className="tile-grid">
          {tiles.map((tile) => (
            <PatientTile key={tile.patient.id} tile={tile} demoNow={board.evaluatedAt} onOpen={() => setSelectedPatientId(tile.patient.id)} />
          ))}
        </div>
      </section>

      {selectedTile && (
        <SbarDrawer
          tile={selectedTile}
          events={board.events.filter((event) => event.patientId === selectedTile.patient.id)}
          demoNow={board.evaluatedAt}
          selectedNurse={selectedNurse}
          draftNote={draftNote}
          onDraftNoteChange={setDraftNote}
          onSaveReview={saveReview}
          onClose={() => setSelectedPatientId(null)}
          onRefresh={() => refreshHandoff(selectedTile.patient.id)}
          isRefreshing={refreshingPatientId === selectedTile.patient.id}
          canRefresh={boardMode !== "degraded"}
        />
      )}
    </main>
  );
}

function PatientTile({ tile, demoNow, onOpen }: { tile: BoardTile & { stale: boolean }; demoNow: string; onOpen: () => void }) {
  const status = coverageStatus(tile);
  const statusText = statusCopy(status);
  const strongestAlert = tile.alerts.find((alert) => alert.priority === "overdue") ?? tile.alerts[0];
  return (
    <article className={`patient-tile coverage-${status}`}>
      <div className="tile-topline">
        <p className="room">ROOM {tile.patient.room}</p>
        <span className={`coverage-badge coverage-${status}`} role="status" aria-label={statusText.label}>
          <span aria-hidden="true">{statusText.icon}</span> {statusText.label}
        </span>
      </div>
      <h3>{tile.patient.displayName}</h3>
      <p className="tile-meta">Assigned to Jamie Rivera, RN</p>
      {tile.stale && <p className="stale-chip" role="status">New source data · refresh required</p>}
      {strongestAlert ? (
        <p className={`action-alert ${strongestAlert.priority === "overdue" ? "is-overdue" : ""}`}>{alertLabel(strongestAlert, demoNow)}</p>
      ) : <p className="no-actions">No due or overdue demo items</p>}
      <div className="tile-bottom">
        <span className={`review-state ${tile.review ? "is-reviewed" : ""}`}>{tile.review ? `Reviewed by ${tile.review.nurseName.split(",")[0]}` : "Needs review"}</span>
        <button type="button" className="open-handoff" onClick={onOpen} aria-label={`Open handoff for ${tile.patient.displayName}`}>Open handoff <span aria-hidden="true">→</span></button>
      </div>
    </article>
  );
}

type DrawerProps = {
  tile: BoardTile & { stale: boolean };
  events: ChartEvent[];
  demoNow: string;
  selectedNurse: DemoNurse | undefined;
  draftNote: string;
  onDraftNoteChange: (note: string) => void;
  onSaveReview: () => void;
  onClose: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  canRefresh: boolean;
};

function SbarDrawer({ tile, events, demoNow, selectedNurse, draftNote, onDraftNoteChange, onSaveReview, onClose, onRefresh, isRefreshing, canRefresh }: DrawerProps) {
  const claimsBySection = Object.keys(sectionLabels).map((section) => ({
    section: section as keyof typeof sectionLabels,
    claims: tile.handoff.claims.filter((claim) => claim.section === section),
  }));
  const status = coverageStatus(tile);
  const statusText = statusCopy(status);

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="sbar-drawer" role="dialog" aria-modal="true" aria-labelledby="handoff-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-header">
          <div>
            <p className="eyebrow">ROOM {tile.patient.room} · {tile.handoff.status === "candidate" ? "CANDIDATE" : "HANDOFF"} v{tile.handoff.versionNumber}</p>
            <h2 id="handoff-title">{tile.patient.displayName}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close handoff">×</button>
        </header>

        <div className={`status-panel coverage-${status}`} role="status">
          <span aria-hidden="true">{statusText.icon}</span>
          <div><strong>{statusText.label}</strong><p>Color reflects evidence coverage and data freshness, not patient acuity.</p></div>
        </div>

        {tile.stale && <section className="stale-panel" aria-label="Handoff needs refresh"><strong>New source data is available.</strong><p>The displayed version is unchanged. Create a candidate only after explicitly refreshing.</p></section>}
        {tile.handoff.status === "candidate" && <section className="candidate-panel" aria-label="Candidate version"><strong>Candidate version</strong><p>This immutable candidate was created by an explicit refresh and is not auto-published.</p></section>}

        <div className="refresh-row"><button className="refresh-button" type="button" onClick={onRefresh} disabled={!canRefresh || isRefreshing}>{isRefreshing ? "Creating candidate…" : "Refresh handoff"}</button><p>{canRefresh ? "Creates a new candidate from currently available synthetic source events." : "Refresh is unavailable while Supabase is disconnected."}</p></div>

        {tile.alerts.length > 0 && <section className="drawer-section" aria-labelledby="upcoming-heading"><h3 id="upcoming-heading">Upcoming items</h3><ul className="alert-list">{tile.alerts.map((alert) => <li key={alert.id} className={alert.priority === "overdue" ? "is-overdue" : ""}>{alertLabel(alert, demoNow)}</li>)}</ul></section>}

        <section className="drawer-section" aria-labelledby="sbar-heading">
          <h3 id="sbar-heading">SBAR handoff</h3>
          {tile.handoff.status === "failed" ? <p className="failure-copy">Handoff unavailable: {tile.handoff.failure?.message ?? "Unknown generation failure."}</p> : (
            <div className="sbar-sections">
              {claimsBySection.map(({ section, claims }) => <SbarSection key={section} section={section} claims={claims} events={events} />)}
            </div>
          )}
        </section>

        {tile.handoff.excludedClaims.length > 0 && <section className="drawer-section evidence-gap"><h3>Evidence gaps</h3><p>{tile.handoff.excludedClaims.length} claim{tile.handoff.excludedClaims.length === 1 ? "" : "s"} withheld from this handoff because verification did not support them.</p></section>}

        <form className="review-form" onSubmit={(event) => { event.preventDefault(); onSaveReview(); }}>
          <div className="review-form-heading"><div><h3>Review handoff</h3><p>{selectedNurse ? `As ${selectedNurse.displayName}` : "Choose a nurse to review."}</p></div>{tile.review && <span className="reviewed-time">Reviewed locally</span>}</div>
          <label htmlFor="handoff-note">Incoming-nurse note <span>(optional)</span></label>
          <textarea id="handoff-note" value={draftNote} onChange={(event) => onDraftNoteChange(event.target.value)} placeholder="Add a concise shift note for this demo…" rows={3} />
          <button className="review-button" type="submit" disabled={!selectedNurse}>{tile.review ? "Update review" : "Mark reviewed"}</button>
        </form>
      </aside>
    </div>
  );
}

function SbarSection({ section, claims, events }: { section: keyof typeof sectionLabels; claims: HandoffClaim[]; events: ChartEvent[] }) {
  const eventById = new Map(events.map((event) => [event.id, event]));
  return (
    <section className="sbar-section">
      <h4>{sectionLabels[section]}</h4>
      {claims.length === 0 ? <p className="empty-section">No evidence-supported content available.</p> : claims.map((claim) => (
        <details key={claim.id} className="claim-detail">
          <summary>{claim.text}</summary>
          <div className="evidence-inspector"><p className="evidence-title">Evidence inspector</p>{claim.evidenceEventIds.map((eventId) => {
            const event = eventById.get(eventId);
            return event ? <div key={event.id} className="evidence-source"><strong>{event.sourceLabel}</strong><span>{event.category.replace("_", " ")} · {new Date(event.recordedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div> : <p key={eventId}>Missing source: {eventId}</p>;
          })}</div>
        </details>
      ))}
    </section>
  );
}
