import type { HandoffVersion } from "@/lib/contracts";
import type { FoundationPatientSnapshot } from "@/lib/engine/board";

export type TileReview = { nurseId: string; nurseName: string; note: string; reviewedAt: string };
export type BoardTile = FoundationPatientSnapshot & { handoff: HandoffVersion; review?: TileReview };

/** Priority communicates work state only; clinical timing remains owned by the deterministic alert engine. */
export function tilePriority(tile: BoardTile): number {
  if (tile.alerts.some((alert) => alert.priority === "overdue")) return 0;
  if (tile.alerts.some((alert) => alert.priority === "imminent")) return 1;
  if (tile.handoff.status === "failed" || tile.freshness.status === "red") return 2;
  if (tile.handoff.excludedClaims.length > 0 || tile.freshness.status === "amber") return 3;
  if (!tile.review) return 4;
  return 5;
}

export function sortBoardTiles<T extends BoardTile>(tiles: T[]): T[] {
  return [...tiles].sort((left, right) =>
    tilePriority(left) - tilePriority(right) || left.patient.room.localeCompare(right.patient.room),
  );
}

export function coverageStatus(tile: BoardTile): "green" | "amber" | "red" {
  if (tile.handoff.status === "failed" || tile.freshness.status === "red") return "red";
  if (tile.handoff.excludedClaims.length > 0 || tile.freshness.status === "amber") return "amber";
  return "green";
}
