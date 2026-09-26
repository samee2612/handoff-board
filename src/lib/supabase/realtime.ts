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

export type WorkflowRealtimeHandlers = {
  onVersion: (row: Record<string, unknown>) => void;
  onReview: (row: Record<string, unknown>) => void;
  onPublication: (row: Record<string, unknown>) => void;
  onStatus: (status: "connected" | "error") => void;
};

/** Shared workflow data is append-only, so subscriptions only accept INSERT notifications. */
export function subscribeToHandoffWorkflow(client: SupabaseClient, handlers: WorkflowRealtimeHandlers) {
  const channel = client
    .channel("synthetic-handoff-workflow")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "handoff_versions" }, (payload) => {
      handlers.onVersion(payload.new as Record<string, unknown>);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "handoff_reviews" }, (payload) => {
      handlers.onReview(payload.new as Record<string, unknown>);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "handoff_publications" }, (payload) => {
      handlers.onPublication(payload.new as Record<string, unknown>);
    })
    .subscribe((status) => handlers.onStatus(status === "SUBSCRIBED" ? "connected" : "error"));
  return () => { void client.removeChannel(channel); };
}
