import { describe, expect, it } from "vitest";
import type { AnalysisOutcome } from "../../../shared/types.js";
import { aggregateStats, type StatsRow } from "../src/services/cockpit/stats.js";

function outcome(status: AnalysisOutcome["status"], pct = 0): AnalysisOutcome {
  return { status, pct_since_anchor: pct, resolved_at: status === "open" ? null : 1 };
}

function row(overrides: Partial<StatsRow> = {}): StatsRow {
  return { direction: "long", origin: "manual", outcome: outcome("hit_target", 2), ...overrides };
}

describe("aggregateStats", () => {
  it("computes win rate from resolved outcomes only", () => {
    const stats = aggregateStats([
      row({ outcome: outcome("hit_target", 4) }),
      row({ outcome: outcome("hit_stop", -2) }),
      row({ outcome: outcome("open", 1) }),
      row({ outcome: null }),
    ]);
    expect(stats.total).toBe(4);
    expect(stats.overall.hit_target).toBe(1);
    expect(stats.overall.hit_stop).toBe(1);
    expect(stats.overall.open).toBe(1);
    expect(stats.overall.unjudged).toBe(1);
    expect(stats.overall.win_rate).toBe(0.5);
    expect(stats.overall.avg_pct).toBe(1);
  });

  it("splits by direction, ignoring neutral for direction buckets", () => {
    const stats = aggregateStats([
      row({ direction: "long", outcome: outcome("hit_target") }),
      row({ direction: "short", outcome: outcome("hit_stop") }),
      row({ direction: "neutral", outcome: null }),
    ]);
    expect(stats.by_direction.long.total).toBe(1);
    expect(stats.by_direction.long.win_rate).toBe(1);
    expect(stats.by_direction.short.total).toBe(1);
    expect(stats.by_direction.short.win_rate).toBe(0);
    expect(stats.overall.total).toBe(3);
  });

  it("splits by origin", () => {
    const stats = aggregateStats([
      row({ origin: "analyst", outcome: outcome("hit_target") }),
      row({ origin: "manual", outcome: outcome("hit_stop") }),
      row({ origin: "manual", outcome: outcome("hit_target") }),
    ]);
    expect(stats.by_origin.analyst.total).toBe(1);
    expect(stats.by_origin.analyst.win_rate).toBe(1);
    expect(stats.by_origin.manual.total).toBe(2);
    expect(stats.by_origin.manual.win_rate).toBe(0.5);
  });

  it("returns null rates when nothing resolved", () => {
    const stats = aggregateStats([row({ outcome: outcome("open") }), row({ outcome: null })]);
    expect(stats.overall.win_rate).toBeNull();
    expect(stats.overall.avg_pct).toBeNull();
  });

  it("handles empty input", () => {
    const stats = aggregateStats([]);
    expect(stats.total).toBe(0);
    expect(stats.overall.win_rate).toBeNull();
  });

  it("splits by trigger and direction, keeping phantom (untriggered) results separate", () => {
    const enteredHit = (v: boolean): AnalysisOutcome => ({ ...outcome("hit_target", 3), entered: v });
    const enteredStop = (v: boolean): AnalysisOutcome => ({ ...outcome("hit_stop", -1), entered: v });
    const stats = aggregateStats([
      row({ direction: "long", outcome: enteredHit(true) }), // 已触发·做多 命中
      row({ direction: "long", outcome: enteredStop(true) }), // 已触发·做多 止损
      row({ direction: "short", outcome: enteredHit(true) }), // 已触发·做空 命中
      row({ direction: "short", outcome: enteredHit(false) }), // 未触发·做空（纸面命中）
      row({ direction: "neutral", outcome: outcome("held_range") }), // 观望不计入触发拆分
      row({ direction: "long", outcome: outcome("hit_target") }), // entered=undefined 老数据，跳过
    ]);
    expect(stats.by_trigger.entered.long.total).toBe(2);
    expect(stats.by_trigger.entered.long.win_rate).toBe(0.5); // 一胜一负
    expect(stats.by_trigger.entered.short.total).toBe(1);
    expect(stats.by_trigger.entered.short.win_rate).toBe(1);
    expect(stats.by_trigger.not_entered.short.total).toBe(1);
    expect(stats.by_trigger.not_entered.short.win_rate).toBe(1); // 纸面上也算命中
    expect(stats.by_trigger.not_entered.long.total).toBe(0);
    // 总体仍把所有预测算进去，不受触发拆分影响。
    expect(stats.overall.total).toBe(6);
  });
});
