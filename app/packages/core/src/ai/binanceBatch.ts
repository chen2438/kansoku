import type {
  BinanceBatchAutomationState,
  BinanceBatchItem,
  BinanceBatchRanking,
  BinanceBatchStartInput,
  BinanceBatchState,
} from "../contract/symbols.js";
import type { BinanceOpenedPositionResult, BinancePlaceTestnetOrderInput } from "../contract/binanceAccount.js";
import { ClientError } from "../errors.js";
import { aiConfig } from "./models.js";
import { runAnalyst } from "./analyst.js";
import { binanceAccountService } from "../modules/binanceAccount/binanceAccount.service.js";
import { latestIntradayDoc } from "../services/cockpit/entryPlan.js";
import {
  getBinanceTopGainers,
  getBinanceTopLosers,
  getBinanceTopUsdtPerpetuals,
  type BinanceVolumeLeader,
} from "../services/marketdata/binance.js";

const CONCURRENCY = 2;
const AUTOMATION_INTERVAL_MS = 60 * 60 * 1000;

interface AnalysisSummary {
  id: string;
  direction?: BinanceBatchItem["direction"];
  entryStatus?: BinanceBatchItem["entryStatus"];
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
}

export interface BinanceBatchDeps {
  leaders: (ranking: BinanceBatchRanking) => Promise<BinanceVolumeLeader[]>;
  analystModel: () => ReturnType<typeof aiConfig>["analystModel"];
  run: typeof runAnalyst;
  latestSummary: (symbol: string) => Promise<AnalysisSummary | null>;
  prepareTrading: () => Promise<void>;
  existingPositionSymbols: () => Promise<Set<string>>;
  placeOrder: (input: BinancePlaceTestnetOrderInput) => Promise<BinanceOpenedPositionResult>;
  now: () => number;
}

const defaultDeps: BinanceBatchDeps = {
  leaders: (ranking) => ranking === "gainers_top10"
    ? getBinanceTopGainers(10)
    : ranking === "losers_top10"
      ? getBinanceTopLosers(10)
      : getBinanceTopUsdtPerpetuals(20),
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
      stopLossPrice: doc.built.entryPlan?.stop ?? null,
      takeProfitPrice: doc.built.entryPlan?.target1 ?? null,
    };
  },
  prepareTrading: async () => {
    const status = await binanceAccountService.status();
    if (!status.configured || !status.connected) {
      throw new ClientError("Binance 测试网账号尚未连接", "请先在设置中连接可交易的测试网 API key", 400);
    }
    if (!status.testnet) {
      throw new ClientError("批量下单只允许使用测试网", "请断开主网账号并改连 Binance 期货测试网", 403, "BINANCE_MAINNET_ORDER_BLOCKED");
    }
  },
  existingPositionSymbols: async () => new Set(
    (await binanceAccountService.positions()).map((position) => position.symbol),
  ),
  placeOrder: (input) => binanceAccountService.placeTestnetOrder(input),
  now: () => Date.now(),
};

let current: BinanceBatchState | null = null;
let automation: BinanceBatchAutomationState | null = null;
let automationTimer: ReturnType<typeof setTimeout> | null = null;

function readableError(error: unknown): string {
  if (error instanceof ClientError) return error.hint ? `${error.message}；处理方法：${error.hint}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

function cloneState(state: BinanceBatchState | null): BinanceBatchState | null {
  return state ? {
    ...state,
    items: state.items.map((item) => ({ ...item })),
    ...(automation ? { automation: { ...automation } } : {}),
  } : null;
}

async function processItem(index: number, deps: BinanceBatchDeps, autoTrade: boolean): Promise<void> {
  if (!current) return;
  const item = current.items[index];
  if (item.status === "skipped") return;
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
    if (autoTrade) {
      if (after.direction === "neutral") {
        item.tradeStatus = "skipped";
      } else if (after.direction !== "long" && after.direction !== "short") {
        item.tradeStatus = "failed";
        item.tradeError = "分析没有给出做多、做空或观望结论";
      } else {
        const stopLossPrice = Number(after.stopLossPrice);
        const takeProfitPrice = Number(after.takeProfitPrice);
        if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0 || !Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0) {
          item.tradeStatus = "failed";
          item.tradeError = "分析缺少有效的止损价或目标1，已跳过下单";
        } else {
          try {
            const batchToken = current?.id.replace("binance-top-", "").slice(-10) ?? "batch";
            const sourceCode = current?.ranking === "gainers_top10" ? "g" : current?.ranking === "losers_top10" ? "l" : "v";
            const order = await deps.placeOrder({
              symbol: item.symbol,
              direction: after.direction === "long" ? "LONG" : "SHORT",
              initialMargin: 20,
              leverage: 20,
              stopLossPrice,
              takeProfitPrice,
              requireFlat: true,
              clientOrderId: `k-${sourceCode}-${batchToken}-${item.rank}-${item.symbol.slice(0, 8).toLowerCase()}`,
              source: current?.ranking ?? "volume_top20",
              confirmed: true,
            });
            item.tradeOrderId = order.entryOrder.orderId;
            if (order.protectionErrors.length > 0) {
              item.tradeStatus = "failed";
              item.tradeError = `仓位已开，但保护单失败：${order.protectionErrors.join("；")}`;
            } else {
              item.tradeStatus = "submitted";
            }
          } catch (error) {
            item.tradeStatus = error instanceof ClientError && error.code === "BINANCE_EXISTING_EXPOSURE" ? "skipped" : "failed";
            item.tradeError = readableError(error);
          }
        }
      }
    }
  } catch (error) {
    item.status = "failed";
    item.error = readableError(error);
  }
}

async function runQueue(deps: BinanceBatchDeps, autoTrade: boolean): Promise<void> {
  if (!current) return;
  let next = 0;
  const worker = async () => {
    while (current && next < current.items.length) {
      const index = next++;
      await processItem(index, deps, autoTrade);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (current) {
    current.status = "completed";
    current.finishedAt = new Date(deps.now()).toISOString();
    if (automation?.active) scheduleNextAutomationRun(deps, Date.parse(current.startedAt));
  }
}

function clearAutomationTimer(): void {
  if (automationTimer) clearTimeout(automationTimer);
  automationTimer = null;
}

function stopAutomation(now: number): void {
  clearAutomationTimer();
  if (!automation) return;
  automation.active = false;
  automation.nextRunAt = undefined;
  automation.stoppedAt = new Date(now).toISOString();
}

function scheduleNextAutomationRun(deps: BinanceBatchDeps, previousRunAt: number): void {
  if (!automation?.active) return;
  clearAutomationTimer();
  const now = deps.now();
  const nextAt = Math.max(previousRunAt + AUTOMATION_INTERVAL_MS, now);
  const endAt = automation.endAt ? Date.parse(automation.endAt) : null;
  if (endAt !== null && nextAt > endAt) {
    stopAutomation(now);
    return;
  }
  automation.nextRunAt = new Date(nextAt).toISOString();
  automationTimer = setTimeout(() => {
    automationTimer = null;
    if (!automation?.active) return;
    automation.nextRunAt = undefined;
    void beginBatch(true, deps, automation.ranking).catch((error) => {
      if (!automation?.active) return;
      automation.lastError = readableError(error);
      scheduleNextAutomationRun(deps, deps.now());
    });
  }, Math.max(0, nextAt - now));
}

async function beginBatch(
  autoTrade: boolean,
  deps: BinanceBatchDeps,
  ranking: BinanceBatchRanking,
): Promise<BinanceBatchState> {
  if (autoTrade) await deps.prepareTrading();
  const [leaders, existingPositions] = await Promise.all([
    deps.leaders(ranking),
    autoTrade ? deps.existingPositionSymbols() : Promise.resolve(new Set<string>()),
  ]);
  const now = deps.now();
  current = {
    id: `binance-top-${now}`,
    mode: autoTrade ? "analysis_and_trade" : "analysis",
    ranking,
    status: "running",
    startedAt: new Date(now).toISOString(),
    items: leaders.map((leader, index) => {
      const hasPosition = existingPositions.has(leader.symbol);
      return {
        symbol: leader.symbol,
        rank: index + 1,
        quoteVolume: leader.quoteVolume,
        changePercent: leader.changePercent,
        status: hasPosition ? "skipped" as const : "queued" as const,
        ...(autoTrade ? { tradeStatus: hasPosition ? "skipped" as const : "pending" as const } : {}),
        ...(hasPosition ? { skipReason: "已有 Binance 合约仓位，已跳过 AI 分析和下单" } : {}),
      };
    }),
  };
  if (automation?.active) {
    automation.runCount += 1;
    automation.lastRunAt = current.startedAt;
    automation.lastError = undefined;
  }
  void runQueue(deps, autoTrade);
  return cloneState(current)!;
}

export async function startBinanceTopAnalysis(
  input: BinanceBatchStartInput = {},
  deps: BinanceBatchDeps = defaultDeps,
): Promise<BinanceBatchState> {
  if (current?.status === "running" || automation?.active) return cloneState(current)!;
  const autoTrade = input.autoTrade === true;
  const ranking = input.ranking ?? "volume_top20";
  if (ranking !== "volume_top20" && ranking !== "gainers_top10" && ranking !== "losers_top10") {
    throw new ClientError("Binance 榜单类型不正确", "请选择成交额 Top 20、涨幅 Top 10 或跌幅 Top 10", 400);
  }
  if (autoTrade && input.confirmed !== true) {
    throw new ClientError("批量下单尚未确认", "请先核对固定保证金、杠杆和最多下单数量", 400, "BINANCE_ORDER_NOT_CONFIRMED");
  }
  const now = deps.now();
  if (input.repeatHourly === true && !autoTrade) {
    throw new ClientError("自动任务必须启用自动下单", "请使用“每小时自动分析并下单”按钮启动", 400);
  }
  if (input.repeatHourly === true) {
    const parsedEndAt = input.automationEndAt ? Date.parse(input.automationEndAt) : null;
    if (input.automationEndAt && (!Number.isFinite(parsedEndAt) || parsedEndAt! <= now)) {
      throw new ClientError("自动任务结束时间必须晚于当前时间", "请选择未来时间，或勾选持续运行", 400);
    }
    automation = {
      active: true,
      continuous: !input.automationEndAt,
      startedAt: new Date(now).toISOString(),
      ...(parsedEndAt !== null ? { endAt: new Date(parsedEndAt).toISOString() } : {}),
      runCount: 0,
      ranking,
    };
  } else {
    automation = null;
  }
  try {
    return await beginBatch(autoTrade, deps, ranking);
  } catch (error) {
    if (automation?.active) stopAutomation(deps.now());
    throw error;
  }
}

export function binanceTopAnalysisState(): BinanceBatchState | null {
  return cloneState(current);
}

export function stopBinanceTopAnalysisAutomation(): BinanceBatchState | null {
  stopAutomation(Date.now());
  return cloneState(current);
}

export function resetBinanceTopAnalysisForTests(): void {
  clearAutomationTimer();
  automation = null;
  current = null;
}
