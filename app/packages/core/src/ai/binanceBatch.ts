import type { BinanceBatchItem, BinanceBatchStartInput, BinanceBatchState } from "../contract/symbols.js";
import type { BinanceOpenedPositionResult, BinancePlaceTestnetOrderInput } from "../contract/binanceAccount.js";
import { ClientError } from "../errors.js";
import { aiConfig } from "./models.js";
import { runAnalyst } from "./analyst.js";
import { binanceAccountService } from "../modules/binanceAccount/binanceAccount.service.js";
import { latestIntradayDoc } from "../services/cockpit/entryPlan.js";
import { getBinanceTopUsdtPerpetuals } from "../services/marketdata/binance.js";

const LIMIT = 20;
const CONCURRENCY = 2;

interface AnalysisSummary {
  id: string;
  direction?: BinanceBatchItem["direction"];
  entryStatus?: BinanceBatchItem["entryStatus"];
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
}

export interface BinanceBatchDeps {
  leaders: typeof getBinanceTopUsdtPerpetuals;
  analystModel: () => ReturnType<typeof aiConfig>["analystModel"];
  run: typeof runAnalyst;
  latestSummary: (symbol: string) => Promise<AnalysisSummary | null>;
  prepareTrading: () => Promise<void>;
  placeOrder: (input: BinancePlaceTestnetOrderInput) => Promise<BinanceOpenedPositionResult>;
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
  placeOrder: (input) => binanceAccountService.placeTestnetOrder(input),
  now: () => Date.now(),
};

let current: BinanceBatchState | null = null;

function readableError(error: unknown): string {
  if (error instanceof ClientError) return error.hint ? `${error.message}；处理方法：${error.hint}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

function cloneState(state: BinanceBatchState | null): BinanceBatchState | null {
  return state ? { ...state, items: state.items.map((item) => ({ ...item })) } : null;
}

async function processItem(index: number, deps: BinanceBatchDeps, autoTrade: boolean): Promise<void> {
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
            const order = await deps.placeOrder({
              symbol: item.symbol,
              direction: after.direction === "long" ? "LONG" : "SHORT",
              initialMargin: 20,
              leverage: 5,
              stopLossPrice,
              takeProfitPrice,
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
            item.tradeStatus = "failed";
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
  }
}

export async function startBinanceTopAnalysis(
  input: BinanceBatchStartInput = {},
  deps: BinanceBatchDeps = defaultDeps,
): Promise<BinanceBatchState> {
  if (current?.status === "running") return cloneState(current)!;
  const autoTrade = input.autoTrade === true;
  if (autoTrade && input.confirmed !== true) {
    throw new ClientError("批量下单尚未确认", "请先核对固定保证金、杠杆和最多下单数量", 400, "BINANCE_ORDER_NOT_CONFIRMED");
  }
  if (autoTrade) await deps.prepareTrading();
  const leaders = await deps.leaders(LIMIT);
  const now = deps.now();
  current = {
    id: `binance-top-${now}`,
    mode: autoTrade ? "analysis_and_trade" : "analysis",
    status: "running",
    startedAt: new Date(now).toISOString(),
    items: leaders.map((leader, index) => ({
      symbol: leader.symbol,
      rank: index + 1,
      quoteVolume: leader.quoteVolume,
      changePercent: leader.changePercent,
      status: "queued",
      ...(autoTrade ? { tradeStatus: "pending" as const } : {}),
    })),
  };
  void runQueue(deps, autoTrade);
  return cloneState(current)!;
}

export function binanceTopAnalysisState(): BinanceBatchState | null {
  return cloneState(current);
}

export function resetBinanceTopAnalysisForTests(): void {
  current = null;
}
