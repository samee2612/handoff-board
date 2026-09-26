import { describe, expect, it } from "vitest";
import { coverageStatus, sortBoardTiles, tilePriority, type BoardTile } from "@/lib/board/priority";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { buildFoundationSnapshot } from "@/lib/engine/board";
import { HandoffPipeline } from "@/lib/handoff/pipeline";

async function fixtureTiles(): Promise<BoardTile[]> {
  const unit = createDemoUnit();
  const snapshots = buildFoundationSnapshot(unit).patients;
  const pipeline = new HandoffPipeline();
  return Promise.all(snapshots.map(async (snapshot) => ({
    ...snapshot,
    handoff: await pipeline.generate(
      snapshot.patient,
      unit.chartEvents.filter((event) => event.patientId === snapshot.patient.id),
      unit.now,
    ),
  })));
}

describe("board tile priority", () => {
  it("puts deterministic upcoming work before missing-data coverage", async () => {
    const sorted = sortBoardTiles(await fixtureTiles());
    expect(sorted.map((tile) => tile.patient.room)).toEqual(["401-A", "401-B", "402-A"]);
    expect(coverageStatus(sorted[2])).toBe("red");
  });

  it("moves a clean reviewed tile behind the same tile awaiting review", async () => {
    const [ava] = await fixtureTiles();
    const cleanTile: BoardTile = { ...ava, alerts: [] };
    const reviewedTile: BoardTile = {
      ...cleanTile,
      review: { nurseId: "demo", nurseName: "Demo Nurse", note: "", reviewedAt: "2026-09-26T19:00:00.000Z" },
    };
    expect(tilePriority(cleanTile)).toBe(4);
    expect(tilePriority(reviewedTile)).toBe(5);
  });
});
