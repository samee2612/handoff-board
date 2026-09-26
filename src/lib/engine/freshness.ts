import type { ChartEvent, ChartEventCategory, FreshnessEvaluation } from "@/lib/contracts";

/** Demonstration-only data recency expectations; they are not clinical monitoring rules. */
export const DEMO_FRESHNESS_MINUTES: Record<ChartEventCategory, number> = {
  nursing_note: 8 * 60,
  vital: 4 * 60,
  medication: 12 * 60,
  task: 12 * 60,
  incident: 24 * 60,
};

const REQUIRED_CATEGORIES: ChartEventCategory[] = ["nursing_note", "vital", "medication", "task"];

export function evaluateFreshness(events: ChartEvent[], now: Date): FreshnessEvaluation {
  const categories = new Map<ChartEventCategory, Date>();
  for (const event of events) {
    const occurredAt = new Date(event.occurredAt);
    const mostRecent = categories.get(event.category);
    if (!mostRecent || occurredAt > mostRecent) categories.set(event.category, occurredAt);
  }

  const missingCategories = REQUIRED_CATEGORIES.filter((category) => !categories.has(category));
  const staleCategories = [...categories.entries()]
    .filter(([category, occurredAt]) => now.getTime() - occurredAt.getTime() > DEMO_FRESHNESS_MINUTES[category] * 60_000)
    .map(([category]) => category);

  return {
    status: missingCategories.length > 0 ? "red" : staleCategories.length > 0 ? "amber" : "green",
    missingCategories,
    staleCategories,
    evaluatedAt: now.toISOString(),
  };
}
