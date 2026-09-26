import type { ActionAlert, ChartEvent } from "@/lib/contracts";

export const DEFAULT_ALERT_WINDOW_MINUTES = 60;

function alertPriority(dueAt: Date, now: Date): "overdue" | "imminent" {
  return dueAt.getTime() < now.getTime() ? "overdue" : "imminent";
}

/**
 * Pure demo logic: reports documented due times and eligibility only. It never determines
 * whether a medication should be administered or whether an item is clinically appropriate.
 */
export function evaluateActionAlerts(
  events: ChartEvent[],
  now: Date,
  upcomingMinutes = DEFAULT_ALERT_WINDOW_MINUTES,
): ActionAlert[] {
  if (!Number.isFinite(upcomingMinutes) || upcomingMinutes < 0) {
    throw new RangeError("upcomingMinutes must be a non-negative finite number");
  }

  const windowEnd = now.getTime() + upcomingMinutes * 60_000;

  return events.flatMap((event): ActionAlert[] => {
    if (event.category === "medication") {
      if (event.payload.status !== "active") return [];
      const dueAt = event.payload.scheduleType === "scheduled" ? event.payload.dueAt : event.payload.nextEligibleAt;
      if (!dueAt) return [];
      const due = new Date(dueAt);
      if (due.getTime() > windowEnd) return [];

      const isPrn = event.payload.scheduleType === "prn";
      return [{
        id: `alert-${event.id}`,
        patientId: event.patientId,
        eventId: event.id,
        kind: isPrn ? "eligible_prn" : "scheduled_medication",
        priority: alertPriority(due, now),
        dueAt,
        title: isPrn
          ? `${event.payload.medicationName} becomes eligible`
          : `${event.payload.medicationName} scheduled dose due`,
        sourceLabel: event.sourceLabel,
      }];
    }

    if (event.category === "task" && event.payload.status === "open" && event.payload.dueAt) {
      const due = new Date(event.payload.dueAt);
      if (due.getTime() > windowEnd) return [];
      return [{
        id: `alert-${event.id}`,
        patientId: event.patientId,
        eventId: event.id,
        kind: "task",
        priority: alertPriority(due, now),
        dueAt: event.payload.dueAt,
        title: event.payload.title,
        sourceLabel: event.sourceLabel,
      }];
    }

    return [];
  }).sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}
