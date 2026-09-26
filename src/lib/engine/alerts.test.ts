import { describe, expect, it } from "vitest";
import { createDemoUnit } from "@/lib/demo/seed-data";
import { evaluateActionAlerts } from "@/lib/engine/alerts";

describe("evaluateActionAlerts", () => {
  it("shows a scheduled dose due in 40 minutes and an eligible PRN without prescribing either", () => {
    const unit = createDemoUnit();
    const alerts = evaluateActionAlerts(unit.chartEvents, unit.now);

    expect(alerts.map((alert) => [alert.kind, alert.title])).toEqual([
      ["eligible_prn", "Oxycodone becomes eligible"],
      ["task", "Reinforce ambulation plan"],
      ["scheduled_medication", "Acetaminophen scheduled dose due"],
    ]);
  });

  it("excludes a due item outside the configured window", () => {
    const unit = createDemoUnit();
    expect(evaluateActionAlerts(unit.chartEvents, unit.now, 30)).toHaveLength(2);
  });

  it("rejects an invalid alert window instead of silently producing misleading results", () => {
    const unit = createDemoUnit();
    expect(() => evaluateActionAlerts(unit.chartEvents, unit.now, -1)).toThrow(RangeError);
  });
});
