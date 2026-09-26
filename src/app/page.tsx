import { connection } from "next/server";
import { ShiftBoard } from "@/components/shift-board";
import { loadBoard } from "@/lib/supabase/board-data";

export default async function Home() {
  // Supabase credentials and source records are evaluated per request, never at build time.
  await connection();
  const board = await loadBoard();

  return <ShiftBoard
    snapshots={board.snapshots}
    events={board.events}
    handoffs={board.handoffs}
    nurses={board.nurses}
    demoNow={board.evaluatedAt}
    boardMode={board.mode}
    sourceMessage={board.sourceMessage}
  />;
}
