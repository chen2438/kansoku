import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModel } from "../src/ai/models.js";
import {
  binanceTopAnalysisState,
  resetBinanceTopAnalysisForTests,
  startBinanceTopAnalysis,
  type BinanceBatchDeps,
} from "../src/ai/binanceBatch.js";

const model = { provider: "openai-codex", id: "gpt-test" } as unknown as AiModel;
const leaders = [
  { symbol: "BTCUSDT", lastPrice: 60_000, changePercent: 1, quoteVolume: 3_000 },
  { symbol: "ETHUSDT", lastPrice: 3_000, changePercent: 2, quoteVolume: 2_000 },
  { symbol: "SOLUSDT", lastPrice: 100, changePercent: -1, quoteVolume: 1_000 },
];

async function waitForCompletion() {
  for (let i = 0; i < 50; i++) {
    const state = binanceTopAnalysisState();
    if (state?.status === "completed") return state;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("batch did not complete");
}

beforeEach(() => resetBinanceTopAnalysisForTests());

describe("Binance Top volume analysis", () => {
  it("runs every leader and records newly generated chart ids", async () => {
    const latest = new Map<string, string>();
    const deps: BinanceBatchDeps = {
      leaders: vi.fn().mockResolvedValue(leaders),
      analystModel: () => model,
      run: (({ symbol }: { symbol: string }) => ({
        started: true,
        done: Promise.resolve().then(() => latest.set(symbol, `chart-${symbol}`)),
      })) as BinanceBatchDeps["run"],
      latestSummary: async (symbol) => {
        const id = latest.get(symbol);
        return id ? { id, direction: "long" as const, entryStatus: "waiting" as const } : null;
      },
      now: () => 1_750_000_000_000,
    };

    const started = await startBinanceTopAnalysis(deps);
    expect(started.items.map((item) => item.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    const completed = await waitForCompletion();
    expect(completed.items.every((item) => item.status === "completed")).toBe(true);
    expect(completed.items.map((item) => item.chartId)).toEqual([
      "chart-BTCUSDT",
      "chart-ETHUSDT",
      "chart-SOLUSDT",
    ]);
    expect(completed.items.every((item) => item.direction === "long" && item.entryStatus === "waiting")).toBe(true);
  });

  it("marks a run failed when no new chart is created", async () => {
    const deps: BinanceBatchDeps = {
      leaders: vi.fn().mockResolvedValue([leaders[0]]),
      analystModel: () => model,
      run: (() => ({ started: true, done: Promise.resolve() })) as BinanceBatchDeps["run"],
      latestSummary: async () => ({ id: "same-chart" }),
      now: () => 1_750_000_000_000,
    };

    await startBinanceTopAnalysis(deps);
    const completed = await waitForCompletion();
    expect(completed.items[0].status).toBe("failed");
    expect(completed.items[0].error).toContain("未生成新图表");
  });

  it("returns the active batch instead of starting a duplicate", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const leaderFn = vi.fn().mockResolvedValue([leaders[0]]);
    const deps: BinanceBatchDeps = {
      leaders: leaderFn,
      analystModel: () => model,
      run: (() => ({ started: true, done: pending })) as BinanceBatchDeps["run"],
      latestSummary: async () => null,
      now: () => 1_750_000_000_000,
    };

    const first = await startBinanceTopAnalysis(deps);
    const second = await startBinanceTopAnalysis(deps);
    expect(second.id).toBe(first.id);
    expect(leaderFn).toHaveBeenCalledTimes(1);
    finish?.();
    await waitForCompletion();
  });
});
