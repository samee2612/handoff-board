import type { SupabaseClient } from "@supabase/supabase-js";
import { chartEventFromSupabaseRow } from "@/lib/supabase/mappers";
import type { ChartEvent } from "@/lib/contracts";

/** Subscribes only to new source events. Generation is deliberately never automatic. */
export function subscribeToSourceEvents(
  client: SupabaseClient,
  onEvent: (event: ChartEvent) => void,
  onStatus?: (status: "connected" | "error") => void,
) {
  const channel = client
    .channel("synthetic-handoff-source-events")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "patient_chart_events" }, (payload) => {
      const event = chartEventFromSupabaseRow(payload.new);
      if (event) onEvent(event);
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") onStatus?.("connected");
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") onStatus?.("error");
    });

  return () => { void client.removeChannel(channel); };
}
