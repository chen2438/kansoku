import type { IntradayPrediction, OverviewRecap, RawBar, RecapSettlementRow } from "../../../../../shared/types.js";
import { listAllCommentDates, listComments } from "../../ai/comments.js";
import { listUsage, listUsageDates, summarizeUsage } from "../../ai/usageStore.js";
import { chartUrl } from "../../chartUrl.js";
import type { OverviewApi } from "../../contract/overview.js";
import { ClientError } from "../../errors.js";
import { normalizeQuote } from "../../realtime/quotes.js";
import { buildOverviewBoard, latestPerSymbol } from "../../services/cockpit/board.js";
import { attachRMultiple, judgeOutcome, zoneFromPrediction } from "../../services/cockpit/outcome.js";
import { backfillOutcomeEntered, getResolvedOutcomes, saveResolvedOutcome } from "../../services/cockpit/outcomeCache.js";
import { aggregateStats, type StatsRow } from "../../services/cockpit/stats.js";
import { getProvider } from "../../services/marketdata/registry.js";
import { easternDate } from "../../services/session.js";
import { listCharts, loadChart } from "../../services/store.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOME_BARS = 300;
const DAILY_BARS = 30;
const RECAP_TTL_MS = 60_000;
const RECAP_HISTORICAL_TTL_MS = 60 * 60_000;
const RECAP_CACHE_MAX = 10;
const RECAP_DATES_LIMIT = 30;

let recapCache = new Map<string, { at: number; data: OverviewRecap }>();
let recapInflight = new Map<string, Promise<OverviewRecap>>();

export function resetOverviewCacheForTests(): void {
  recapCache = new Map();
  recapInflight = new Map();
}

function cacheRecap(date: string, data: OverviewRecap): void {
  recapCache.delete(date);
  recapCache.set(date, { at: Date.now(), data });
  while (recapCache.size > RECAP_CACHE_MAX) {
    const oldestKey = recapCache.keys().next().value;
    if (oldestKey === undefined) break;
    recapCache.delete(oldestKey);
  }
}

async function computeHistoricalDayPct(symbol: string, date: string): Promise<number | null> {
  const bars = await getProvider(symbol)
    .getKline(symbol, "day", DAILY_BARS)
    .catch(() => null);
  if (!bars) return null;
  const idx = bars.findIndex((bar) => easternDate(new Date(bar.time)) === date);
  if (idx <= 0) return null;
  const close = Number(bars[idx].close);
  const prevClose = Number(bars[idx - 1].close);
  if (!Number.isFinite(close) || !Number.isFinite(prevClose) || prevClose === 0) return null;
  return ((close - prevClose) / prevClose) * 100;
}

async function buildRecap(date: string): Promise<OverviewRecap> {
  const isToday = date === easternDate();
  const metas = (await listCharts({ type: "intraday" })).filter((m) => easternDate(new Date(m.created_at)) === date);
  const bySymbol = latestPerSymbol(metas);
  const symbols = [...bySymbol.keys()];
  const usage = summarizeUsage(date, await listUsage(date));
  if (!symbols.length) {
    return { date, settlements: [], alerts: [], usage };
  }

  const nowMs = Date.now();
  const latestMetas = [...bySymbol.values()];
  const [quoteBySymbol, dayPctBySymbol, docs, commentsList, cached] = await Promise.all([
    isToday
      ? Promise.all(
          symbols.map(async (symbol) => {
            const quotes = await getProvider(symbol)
              .getQuotes([symbol])
              .catch(() => []);
            return quotes[0] ? normalizeQuote(quotes[0], nowMs) : null;
          }),
        ).then((cells) => {
          const map = new Map<string, ReturnType<typeof normalizeQuote>>();
          for (const cell of cells) if (cell) map.set(cell.symbol, cell);
          return map;
        })
      : Promise.resolve(new Map<string, ReturnType<typeof normalizeQuote>>()),
    isToday
      ? Promise.resolve(new Map<string, number | null>())
      : Promise.all(symbols.map(async (s) => [s, await computeHistoricalDayPct(s, date)] as const)).then(
          (entries) => new Map(entries),
        ),
    Promise.all(latestMetas.map((m) => loadChart(m.id))),
    Promise.all(symbols.map((s) => listComments(s, date))),
    getResolvedOutcomes(latestMetas.map((m) => m.id)),
  ]);

  const settlements: RecapSettlementRow[] = await Promise.all(
    latestMetas.map(async (meta, i) => {
      const doc = docs[i];
      const prediction = (doc?.input.prediction as IntradayPrediction | null | undefined) ?? null;
      const direction = prediction?.direction ?? null;
      const anchor = prediction?.anchor ? { time: prediction.anchor.time, price: prediction.anchor.price } : null;
      const plan =
        doc && doc.built.kind === "intraday" && doc.built.entryPlan
          ? { entry: doc.built.entryPlan.entry, stop: doc.built.entryPlan.stop, target1: doc.built.entryPlan.target1 }
          : null;
      let outcome = attachRMultiple(cached.get(meta.id) ?? null, direction, plan);
      if (!outcome && direction && anchor) {
        const bars = await getProvider(meta.symbol!)
          .getKline(meta.symbol!, "15m", OUTCOME_BARS)
          .catch(() => null);
        outcome = bars ? judgeOutcome(direction, anchor, plan, bars, zoneFromPrediction(prediction)) : null;
        if (outcome && outcome.status !== "open") {
          void saveResolvedOutcome({ chartId: meta.id, symbol: meta.symbol!, direction }, outcome).catch(() => {});
        }
      }
      const day_pct = isToday
        ? (quoteBySymbol.get(meta.symbol!)?.regularPct ?? quoteBySymbol.get(meta.symbol!)?.pct ?? null)
        : (dayPctBySymbol.get(meta.symbol!) ?? null);
      return {
        symbol: meta.symbol!,
        chart_id: meta.id,
        direction,
        day_pct,
        outcome,
      };
    }),
  );

  const alerts = commentsList
    .flat()
    .filter((c) => c.level === "alert")
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .map((c) => ({ ts: c.ts, symbol: c.symbol, level: c.level, text: c.text }));

  return { date, settlements, alerts, usage };
}

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) {
    throw new ClientError(`invalid date: ${date}`, "expected YYYY-MM-DD");
  }
}

export const overviewService: OverviewApi = {
  async board() {
    return buildOverviewBoard(chartUrl);
  },

  async recap(input) {
    const date = input.date ?? easternDate();
    assertDate(date);
    const isToday = date === easternDate();
    const ttl = isToday ? RECAP_TTL_MS : RECAP_HISTORICAL_TTL_MS;
    const cached = recapCache.get(date) ?? null;
    if (cached && Date.now() - cached.at < ttl) {
      return cached.data;
    }
    let inflight = recapInflight.get(date);
    if (!inflight) {
      inflight = buildRecap(date)
        .then((data) => {
          cacheRecap(date, data);
          return data;
        })
        .finally(() => {
          recapInflight.delete(date);
        });
      recapInflight.set(date, inflight);
    }
    if (cached) {
      void inflight.catch(() => {});
      return cached.data;
    }
    return inflight;
  },

  async stats() {
    const metas = (await listCharts({ type: "intraday" })).filter((m) => m.symbol);
    const docs = await Promise.all(metas.map((m) => loadChart(m.id)));
    const cached = await getResolvedOutcomes(metas.map((m) => m.id));

    const dirOf = (i: number) => (docs[i]?.input.prediction as IntradayPrediction | null | undefined)?.direction;
    // 需要 K 线：①没缓存要现算；②有缓存但方向性且缺触发状态（老数据回填 entered）。
    const needsBars = (i: number): boolean => {
      const c = cached.get(metas[i].id);
      if (!c) return true;
      const dir = dirOf(i);
      return (dir === "long" || dir === "short") && c.entered == null;
    };
    const symbolsNeedingBars = [...new Set(metas.filter((_, i) => needsBars(i)).map((m) => m.symbol!))];
    const barsBySymbol = new Map<string, RawBar[] | null>();
    await Promise.all(
      symbolsNeedingBars.map(async (symbol) => {
        const bars = await getProvider(symbol)
          .getKline(symbol, "15m", OUTCOME_BARS)
          .catch(() => null);
        barsBySymbol.set(symbol, bars);
      }),
    );

    const rows: StatsRow[] = [];
    metas.forEach((meta, i) => {
      const doc = docs[i];
      const prediction = (doc?.input.prediction as IntradayPrediction | null | undefined) ?? null;
      if (!prediction?.direction) return;
      const anchor = prediction.anchor ? { time: prediction.anchor.time, price: prediction.anchor.price } : null;
      const ep = doc && doc.built.kind === "intraday" ? doc.built.entryPlan : null;
      const plan = ep
        ? { entry: ep.entry, stop: ep.stop, target1: ep.target1, entry_kind: ep.entry_kind ?? null, trigger: ep.trigger ?? null }
        : null;
      const bars = barsBySymbol.get(meta.symbol!) ?? null;
      const zone = zoneFromPrediction(prediction);
      let outcome = attachRMultiple(cached.get(meta.id) ?? null, prediction.direction, plan);
      if (!outcome) {
        outcome = anchor && bars ? judgeOutcome(prediction.direction, anchor, plan, bars, zone) : null;
        if (outcome && outcome.status !== "open") {
          void saveResolvedOutcome(
            { chartId: meta.id, symbol: meta.symbol!, direction: prediction.direction },
            outcome,
          ).catch(() => {});
        }
      } else if (
        outcome.entered == null &&
        (prediction.direction === "long" || prediction.direction === "short") &&
        anchor &&
        bars
      ) {
        // 老数据回填：用现有 K 线重算 entered，status/resolved 仍取缓存的冻结值。
        const rejudged = judgeOutcome(prediction.direction, anchor, plan, bars, zone);
        if (rejudged) {
          outcome = { ...outcome, entered: rejudged.entered ?? null };
          if (rejudged.entered != null) void backfillOutcomeEntered(meta.id, rejudged.entered).catch(() => {});
        }
      }
      rows.push({
        direction: prediction.direction,
        origin: doc?.input.origin === "analyst" ? "analyst" : "manual",
        outcome,
        ts: meta.created_at,
      });
    });

    const now = Date.now();
    const todayE = easternDate(new Date(now));
    const dayMs = 86_400_000;
    const since = (days: number) => rows.filter((r) => r.ts != null && now - new Date(r.ts).getTime() <= days * dayMs);
    return {
      windows: {
        today: aggregateStats(rows.filter((r) => r.ts != null && easternDate(new Date(r.ts)) === todayE)),
        d3: aggregateStats(since(3)),
        d7: aggregateStats(since(7)),
        d30: aggregateStats(since(30)),
        d90: aggregateStats(since(90)),
        all: aggregateStats(rows),
      },
    };
  },

  async usage(input) {
    const date = input.date ?? easternDate();
    assertDate(date);
    return summarizeUsage(date, await listUsage(date));
  },

  async recapDates() {
    const [usageDates, commentDates, intradayMetas] = await Promise.all([
      listUsageDates(RECAP_DATES_LIMIT),
      listAllCommentDates(RECAP_DATES_LIMIT),
      listCharts({ type: "intraday" }),
    ]);
    const chartDates = intradayMetas.map((m) => easternDate(new Date(m.created_at)));
    return [...new Set([...usageDates, ...commentDates, ...chartDates])].sort().reverse().slice(0, RECAP_DATES_LIMIT);
  },
};
