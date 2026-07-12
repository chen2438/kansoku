import type { BinanceBatchItem, BinanceBatchState } from "../contract/symbols.js";
import { aiConfig } from "./models.js";
import { runAnalyst } from "./analyst.js";
import { latestIntradayDoc } from "../services/cockpit/entryPlan.js";
import { getBinanceTopUsdtPerpetuals } from "../services/marketdata/binance.js";

const LIMIT = 20;
const CONCURRENCY = 2;

interface AnalysisSummary {
  id: string;
  direction?: BinanceBatchItem["direction"];
  entryStatus?: BinanceBatchItem["entryStatus"];
}

export interface BinanceBatchDeps {
  leaders: typeof getBinanceTopUsdtPerpetuals;
  analystModel: () => ReturnType<typeof aiConfig>["analystModel"];
  run: typeof runAnalyst;
  latestSummary: (symbol: string) => Promise<AnalysisSummary | null>;
  now: () => number;
}

const defaultDeps: BinanceBatchDeps = {
  leaders: getBinanceTopUsdtPerpetuals,
  analystModel: () => aiConfig().analystModel,
  run: runAnalyst,
  latestSummary: async (symbol) => {
    const doc = await latestIntradayDoc(symbol);
    if (!doc) return null;
    if (doc.built.kind !== "intraday") return { id: doc.id };
    return {
      id: doc.id,
      direction: doc.built.sidebar.prediction?.direction,
      entryStatus: doc.built.entryPlan?.entry_status ?? null,
    };
  },
  now: () => Date.now(),
};

let current: BinanceBatchState | null = null;

function cloneState(state: BinanceBatchState | null): BinanceBatchState | null {
  return state ? { ...state, items: state.items.map((item) => ({ ...item })) } : null;
}

async function processItem(index: number, deps: BinanceBatchDeps): Promise<void> {
  if (!current) return;
  const item = current.items[index];
  item.status = "running";
  try {
    const before = (await deps.latestSummary(item.symbol))?.id ?? null;
    const model = deps.analystModel();
    if (!model) throw new Error("分析模型未配置");
    const result = deps.run({ symbol: item.symbol, origin: "manual", deps: { model } });
    if (!result.started) throw new Error(result.reason ?? "分析未启动");
    await result.done;
    const after = await deps.latestSummary(item.symbol);
    if (!after || after.id === before) throw new Error("分析结束但未生成新图表");
    item.status = "completed";
    item.chartId = after.id;
    item.direction = after.direction;
    item.entryStatus = after.entryStatus;
  } catch (error) {
    item.status = "failed";
    item.error = error instanceof Error ? error.message : String(error);
  }
}

async function runQueue(deps: BinanceBatchDeps): Promise<void> {
  if (!current) return;
  let next = 0;
  const worker = async () => {
    while (current && next < current.items.length) {
      const index = next++;
      await processItem(index, deps);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (current) {
    current.status = "completed";
    current.finishedAt = new Date(deps.now()).toISOString();
  }
}

export async function startBinanceTopAnalysis(deps: BinanceBatchDeps = defaultDeps): Promise<BinanceBatchState> {
  if (current?.status === "running") return cloneState(current)!;
  const leaders = await deps.leaders(LIMIT);
  const now = deps.now();
  current = {
    id: `binance-top-${now}`,
    status: "running",
    startedAt: new Date(now).toISOString(),
    items: leaders.map((leader, index) => ({
      symbol: leader.symbol,
      rank: index + 1,
      quoteVolume: leader.quoteVolume,
      changePercent: leader.changePercent,
      status: "queued",
    })),
  };
  void runQueue(deps);
  return cloneState(current)!;
}

export function binanceTopAnalysisState(): BinanceBatchState | null {
  return cloneState(current);
}

export function resetBinanceTopAnalysisForTests(): void {
  current = null;
}
