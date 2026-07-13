import type { ChartDoc, RawBar, TimeframeKey } from "../../../../shared/types.js";
import { ClientError } from "../errors.js";
import { buildChart, rebuild, refreshBody } from "../services/build.js";
import { TIMEFRAME_ORDER } from "../services/intraday.js";
import { getLongbridgeStream, type CandlePeriod } from "../services/marketdata/longbridgeStream.js";
import { isBinanceSymbol } from "../services/symbol.utils.js";
import { classifySession, isCurrentSessionId } from "../services/session.js";
import { predictionStale } from "../services/staleness.js";
import { loadChart } from "../services/store.js";
import { mergeCandleBar, mergeFreshBars, type PushBar } from "./candleMerge.js";
import { createPoller, type PollerHandle } from "./poller.js";
import { isPushFresh, pollIntervalMs } from "./pushFallback.js";

const LIVE_TYPES = new Set(["flow", "intraday"]);

const TF_TO_CANDLE_PERIOD: Record<TimeframeKey, CandlePeriod> = { m5: "5m", m15: "15m", h1: "60m" };
const DEBOUNCE_MS = 250;
const PUSH_FRESH_WINDOW_MS = 3_000;

function chartIntervalMs(key?: string): number {
  const state = key ? candleStates.get(key) : undefined;
  // Binance 是 24 小时市场，不该按美股时段降频（否则美股收盘后图表每 5 分钟
  // 才刷一次，价格严重滞后）——始终按常规盘档（15 秒）刷新。
  const session =
    state && isBinanceSymbol(state.symbol) ? "regular" : classifySession(Math.floor(Date.now() / 1000));
  const now = Date.now();
  const lastPushAt = state?.lastPushAt ?? null;
  if (state) {
    const fresh = isPushFresh(lastPushAt, now, PUSH_FRESH_WINDOW_MS);
    if (state.pushMode !== fresh) {
      state.pushMode = fresh;
      console.log(`[chart-live] ${key} ${fresh ? "push-driven — poller demoted to overnight tier" : "push stale — poller reverting to session tier"}`);
    }
  }
  return pollIntervalMs(lastPushAt, now, session, PUSH_FRESH_WINDOW_MS);
}

const chartPollers = new Map<string, PollerHandle>();

function predictionFields(doc: ChartDoc) {
  return { prediction_updated_at: doc.prediction_updated_at, prediction_stale: predictionStale(doc, new Date()) };
}

interface CandleState {
  id: string;
  symbol: string;
  viewCount: number | undefined;
  timeframes: Partial<Record<TimeframeKey, RawBar[]>>;
  lastPushAt: number | null;
  lastRebuildAt: number;
  pushMode: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  unsubs: Array<() => void>;
}

const candleStates = new Map<string, CandleState>();

// Leading-edge throttle: an idle chart rebuilds immediately on the first push,
// then at most every DEBOUNCE_MS while pushes keep streaming in.
function scheduleDebouncedRebuild(key: string): void {
  const state = candleStates.get(key);
  if (!state || state.debounceTimer) return;
  const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - state.lastRebuildAt));
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    state.lastRebuildAt = Date.now();
    void runPushRebuild(key).catch((err) => {
      console.warn("[chart-live] push rebuild failed", key, err);
    });
  }, wait);
}

// Rebuild an intraday chart from the live in-memory candle state (the frozen
// analysis snapshot plus whatever bars push/poller have merged in). Both the
// streaming push path and the poller safety net funnel through here so the two
// never diverge on the same series.
async function buildFromState(state: CandleState, latest: ChartDoc): Promise<Record<string, unknown>> {
  const latestInput = latest.input as Record<string, unknown>;
  const timeframes = state.timeframes;
  const lastM5 = timeframes.m5?.[timeframes.m5.length - 1];
  const input: Record<string, unknown> = {
    ...latestInput,
    timeframes,
    as_of: lastM5?.time ?? latestInput.as_of,
  };
  const result = rebuild("intraday", input, latest.title);
  return { built: result.built, ...predictionFields({ ...latest, built: result.built }) };
}

async function runPushRebuild(key: string): Promise<void> {
  const state = candleStates.get(key);
  const handle = chartPollers.get(key);
  if (!state || !handle) return;
  const latest = await loadChart(state.id);
  if (!latest) return;
  handle.pushData(await buildFromState(state, latest));
}

function setupCandleState(key: string, id: string, viewCount: number | undefined, doc: ChartDoc): void {
  if (candleStates.has(key)) return;
  const symbol = (doc.input as Record<string, unknown>).symbol;
  if (typeof symbol !== "string" || !symbol) return;
  const state: CandleState = {
    id,
    symbol,
    viewCount,
    timeframes: Object.fromEntries(
      Object.entries((doc.input as Record<string, unknown>).timeframes as Partial<Record<TimeframeKey, RawBar[]>>)
        .map(([tf, bars]) => [tf, viewCount === undefined ? bars : bars?.slice(-viewCount)]),
    ) as Partial<Record<TimeframeKey, RawBar[]>>,
    lastPushAt: null,
    lastRebuildAt: 0,
    pushMode: false,
    debounceTimer: null,
    unsubs: [],
  };
  candleStates.set(key, state);
  if (isBinanceSymbol(symbol)) return;
  const stream = getLongbridgeStream();
  for (const tf of TIMEFRAME_ORDER) {
    const period = TF_TO_CANDLE_PERIOD[tf];
    const unsub = stream.subscribeCandlesticks(symbol, period, (bar) => {
      const cur = candleStates.get(key);
      if (!cur) return;
      const bars = cur.timeframes[tf] ?? [];
      const pushBar: PushBar = { ts: bar.ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
      cur.timeframes[tf] = mergeCandleBar(bars, pushBar);
      cur.lastPushAt = Date.now();
      scheduleDebouncedRebuild(key);
    });
    state.unsubs.push(unsub);
  }
}

function teardownCandleState(key: string): void {
  const state = candleStates.get(key);
  if (!state) return;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  for (const unsub of state.unsubs) unsub();
  candleStates.delete(key);
}

export async function subscribeChart(id: string, push: (envelope: string) => void, count?: number): Promise<() => void> {
  const doc = await loadChart(id);
  if (!doc) throw new ClientError(`chart not found: ${id}`, undefined, 404);

  const viewCount = count !== undefined && doc.type === "intraday" ? count : undefined;
  if (viewCount === undefined) {
    push(JSON.stringify({ type: "data", data: { built: doc.built, ...predictionFields(doc) } }));
  }

  // 美股图表按"当日 session"关闭实时刷新（隔日 id 不再是当前 session 就冻结成历史快照）。
  // 但 Binance 是 24 小时连续市场，chart id 里的 sessionDate 只是创建时最后一根 K 线的日期，
  // 一旦 ET/UTC 跨日、或最后一根 K 线的 UTC 日期与 ET 日期不一致，isCurrentSessionId 就会变 false，
  // 导致轮询器根本不启动、价格永远停在分析时刻。Binance 品种不受 session 边界约束，始终允许实时刷新。
  const rawSymbol = (doc.input as Record<string, unknown>).symbol;
  const docSymbol = typeof rawSymbol === "string" ? rawSymbol : "";
  const sessionCurrent = isBinanceSymbol(docSymbol) || isCurrentSessionId(id);
  if (!LIVE_TYPES.has(doc.type) || !refreshBody(doc.type, doc.input) || !sessionCurrent) return () => {};

  const key = viewCount === undefined ? id : `${id}#${viewCount}`;
  let handle = chartPollers.get(key);
  if (!handle) {
    if (doc.type === "intraday") setupCandleState(key, id, viewCount, doc);
    handle = createPoller({
      intervalMs: () => chartIntervalMs(key),
      task: async () => {
        const latest = await loadChart(id);
        if (!latest) throw new ClientError(`chart not found: ${id}`, undefined, 404);
        const body = refreshBody(latest.type, latest.input);
        if (!body) return { built: latest.built, ...predictionFields(latest) };
        const result = await buildChart(viewCount === undefined ? body : { ...body, count: viewCount });
        if (latest.type === "intraday") {
          // Safety net converges WITHOUT clobbering the frozen analysis snapshot:
          // fold the full refetch into state.timeframes tail-only (mergeFreshBars
          // pins bars older than the current tail), then rebuild from the merged
          // state so push and poller share one series and history stays put.
          const state = candleStates.get(key);
          if (state) {
            const freshTf = (result.input.timeframes ?? {}) as Partial<Record<TimeframeKey, RawBar[]>>;
            for (const tf of TIMEFRAME_ORDER) {
              const incoming = freshTf[tf];
              if (incoming) state.timeframes[tf] = mergeFreshBars(state.timeframes[tf] ?? [], incoming);
            }
            return await buildFromState(state, latest);
          }
        }
        return { built: result.built, ...predictionFields(latest) };
      },
      onStop: () => {
        chartPollers.delete(key);
        teardownCandleState(key);
      },
    });
    chartPollers.set(key, handle);
  }
  return handle.subscribe(push);
}
