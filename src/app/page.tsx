import { createDemoUnit } from "@/lib/demo/seed-data";
import { buildFoundationSnapshot } from "@/lib/engine/board";
import { HandoffPipeline } from "@/lib/handoff/pipeline";
import { ShiftBoard } from "@/components/shift-board";

export default async function Home() {
  const demo = createDemoUnit();
  const board = buildFoundationSnapshot(demo);
  const pipeline = new HandoffPipeline();
  const handoffs = await Promise.all(board.patients.map((snapshot) => pipeline.generate(
    snapshot.patient,
    demo.chartEvents.filter((event) => event.patientId === snapshot.patient.id),
    demo.now,
  )));

  return <ShiftBoard snapshots={board.patients} events={demo.chartEvents} handoffs={handoffs} nurses={demo.nurses} demoNow={demo.now.toISOString()} />;
}
