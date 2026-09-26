import { createDemoUnit } from "@/lib/demo/seed-data";
import { buildFoundationSnapshot } from "@/lib/engine/board";

export default function Home() {
  const demo = createDemoUnit();
  const board = buildFoundationSnapshot(demo);

  return (
    <main style={{ fontFamily: "system-ui", margin: "3rem auto", maxWidth: 800 }}>
      <p style={{ color: "#475569", fontWeight: 600 }}>FOUNDATION · SYNTHETIC DATA ONLY</p>
      <h1>Automated Nursing Shift Handoff Board</h1>
      <p>
        The foundation is ready with {board.patients.length} fictional patients, a deterministic
        alert engine, freshness checks, and an optional Supabase connection.
      </p>
      <ul>
        {board.patients.map((patient) => (
          <li key={patient.patient.id}>
            Room {patient.patient.room}: {patient.patient.displayName} — {patient.alerts.length} action
            {patient.alerts.length === 1 ? "" : "s"}, data {patient.freshness.status}
          </li>
        ))}
      </ul>
      <p>
        This is not a clinical tool and must not be used with real patient data. The interactive
        handoff board begins in step 3.
      </p>
    </main>
  );
}
