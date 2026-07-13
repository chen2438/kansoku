import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { IntradayPrediction, RawBar, SymbolAnalysisRow } from "../../../../../shared/types.js";
import { runAnalyst } from "../../ai/analyst.js";
import { binanceTopAnalysisState, startBinanceTopAnalysis, stopBinanceTopAnalysisAutomation } from "../../ai/binanceBatch.js";
import { listCommentDates, listComments } from "../../ai/comments.js";
import { deepDiveState, startDeepDive } from "../../ai/deepDive.js";
import { aiConfig } from "../../ai/models.js";
import { chartUrl } from "../../chartUrl.js";
import type { SymbolsApi } from "../../contract/symbols.js";
import { JOURNAL_DIR, STOCKS_DIR } from "../../env.js";
import { ClientError } from "../../errors.js";
import { normalizeQuote } from "../../realtime/quotes.js";
import { buildBenchmark } from "../../services/cockpit/benchmark.js";
import { entryPlanFromDoc, latestIntradayDoc } from "../../services/cockpit/entryPlan.js";
import { buildCockpitFlow } from "../../services/cockpit/flow.js";
import { attachRMultiple, judgeOutcome, zoneFromPrediction } from "../../services/cockpit/outcome.js";
import { getResolvedOutcomes, saveResolvedOutcome } from "../../services/cockpit/outcomeCache.js";
import { buildCockpitPosition } from "../../services/cockpit/position.js";
import { toTs } from "../../services/indicators.js";
import { getProvider } from "../../services/marketdata/registry.js";
import { getBinanceInstrument } from "../../services/marketdata/binance.js";
import type { RawPosition } from "../../services/marketdata/types.js";
import { computeRelativeVolume } from "../../services/relvol.js";
import { classifySession, easternDate } from "../../services/session.js";
import { predictionStale } from "../../services/staleness.js";
import { listCharts, loadChart } from "../../services/store.js";
import { isBinanceSymbol, noteFileName, normalizeSymbol } from "../../services/symbol.utils.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const JOURNAL_FILE_RE = /^(\d{4}-\d{2}-\d{2})-([\w-]+)\.md$/;
const JOURNAL_NAME_RE = /^\d{4}-\d{2}-\d{2}-[\w-]+\.md$/;
const BENCHMARK_SYMBOLS = ["SMH.US", "QQQ.US"];

export const symbolsService: SymbolsApi = {
  async validate(input) {
    const sym = normalizeSymbol(input.sym);
    if (isBinanceSymbol(sym)) {
      const info = await getBinanceInstrument(sym);
      if (info.status !== "TRADING") throw new ClientError(`${sym} is not currently trading`, `Binance status: ${info.status}`, 404);
      return { symbol: sym, provider: "binance-usdm", source: "Binance USD-M Futures", marketType: info.contractType === "TRADIFI_PERPETUAL" ? "TradFi 永续合约" : "加密永续合约", contractType: info.contractType, underlyingType: info.underlyingType };
    }
    try {
      const quotes = await getProvider(sym).getQuotes([sym]);
      if (!quotes.length || !Number.isFinite(Number(quotes[0].last))) throw new Error("empty quote");
    } catch { throw new ClientError(`未找到标的 ${sym}`, "请检查代码，或确认 Longbridge 当前支持该市场。", 404); }
    const suffix = sym.split(".").at(-1);
    return { symbol: sym, provider: "longbridge", source: "Longbridge", marketType: suffix === "US" ? "美股" : suffix === "HK" ? "港股" : suffix === "SH" || suffix === "SZ" ? "A 股" : "证券" };
  },

  async derivatives(input) {
    const sym = normalizeSymbol(input.sym); const provider = getProvider(sym);
    if (!provider.getDerivativesSnapshot) throw new ClientError(`${sym} is not a derivatives symbol`, "Use a Binance USD-M symbol.", 400);
    return provider.getDerivativesSnapshot(sym);
  },

  async flow(input) {
    const sym = normalizeSymbol(input.sym);
    const provider = getProvider(sym);
    if (!provider.getFlow) return null;
    const [flowRes, distRes] = await Promise.allSettled([
      provider.getFlow(sym),
      provider.getCapitalDistribution?.(sym) ?? Promise.resolve(null),
    ]);
    if (flowRes.status === "rejected") throw flowRes.reason;
    const dist = distRes.status === "fulfilled" ? distRes.value : null;
    return buildCockpitFlow(flowRes.value, dist);
  },

  async benchmark(input) {
    const sym = normalizeSymbol(input.sym);
    const base = isBinanceSymbol(sym) ? ["BTCUSDT", "ETHUSDT"] : BENCHMARK_SYMBOLS;
    const symbols = [sym, ...base.filter((s) => s !== sym)];
    const barsList = await Promise.all(symbols.map((s) => getProvider(s).getKline(s, "5m", 100)));
    const regularBars = isBinanceSymbol(sym) ? barsList : barsList.map((bars) => bars.filter((b) => classifySession(toTs(b.time)) === "regular"));
    return buildBenchmark(symbols.map((s, i) => ({ symbol: s, bars: regularBars[i] })));
  },

  async position(input) {
    const sym = normalizeSymbol(input.sym);
    const provider = getProvider(sym);
    const [positions, quotes] = await Promise.all([
      provider.getPositions?.() ?? Promise.resolve([] as RawPosition[]),
      provider.getQuotes([sym]),
    ]);
    if (quotes.length === 0) {
      throw new ClientError(`no quote data for ${sym}`, undefined, 502);
    }
    const quote = normalizeQuote(quotes[0], Date.now());
    const plan = entryPlanFromDoc(await latestIntradayDoc(sym));
    return buildCockpitPosition(positions, sym, quote.last, plan);
  },

  async analyses(input) {
    const sym = normalizeSymbol(input.sym);
    const metas = await listCharts({ symbol: sym, type: "intraday" });
    const docs = await Promise.all(metas.map((m) => loadChart(m.id)));
    const cached = await getResolvedOutcomes(metas.map((m) => m.id));
    let bars: RawBar[] | null = null;
    if (metas.some((m) => !cached.has(m.id))) {
      try {
        bars = await getProvider(sym).getKline(sym, "15m", 300);
      } catch {
        bars = null;
      }
    }
    const rows: SymbolAnalysisRow[] = metas.map((meta, i) => {
      const doc = docs[i];
      const prediction = (doc?.input.prediction as IntradayPrediction | null | undefined) ?? null;
      const direction = prediction?.direction ?? null;
      const anchor = prediction?.anchor ? { time: prediction.anchor.time, price: prediction.anchor.price } : null;
      const plan =
        doc && doc.built.kind === "intraday" && doc.built.entryPlan
          ? { entry: doc.built.entryPlan.entry, stop: doc.built.entryPlan.stop, target1: doc.built.entryPlan.target1 }
          : null;
      let outcome = attachRMultiple(cached.get(meta.id) ?? null, direction, plan);
      if (!outcome && direction && anchor && bars) {
        outcome = judgeOutcome(direction, anchor, plan, bars, zoneFromPrediction(prediction));
        if (outcome && outcome.status !== "open") {
          void saveResolvedOutcome({ chartId: meta.id, symbol: sym, direction }, outcome).catch(() => {});
        }
      }
      return { ...meta, url: chartUrl(meta), direction, anchor, outcome };
    });
    return rows;
  },

  async relvol(input) {
    const sym = normalizeSymbol(input.sym);
    const bars = await getProvider(sym).getKline(sym, "15m", 500);
    return computeRelativeVolume(bars);
  },

  async comments(input) {
    const sym = normalizeSymbol(input.sym);
    const date = input.date ?? easternDate();
    if (!DATE_RE.test(date)) {
      throw new ClientError(`invalid date: ${date}`, "expected YYYY-MM-DD");
    }
    return listComments(sym, date);
  },

  async commentDates(input) {
    const sym = normalizeSymbol(input.sym);
    return listCommentDates(sym);
  },

  async journal(input) {
    const bare = normalizeSymbol(input.sym).replace(/\.US$/, "").toLowerCase();
    let files: string[];
    try {
      files = await fs.readdir(JOURNAL_DIR);
    } catch {
      return [];
    }
    const rows: { name: string; date: string }[] = [];
    for (const f of files) {
      const m = JOURNAL_FILE_RE.exec(f);
      if (!m) continue;
      const rest = m[2].toLowerCase();
      if (rest !== bare && !rest.startsWith(`${bare}-`)) continue;
      rows.push({ name: f, date: m[1] });
    }
    rows.sort((a, b) => (a.name < b.name ? 1 : -1));
    return rows;
  },

  async journalEntry(input) {
    if (!JOURNAL_NAME_RE.test(input.name)) {
      throw new ClientError(`invalid journal name: ${input.name}`, "expected YYYY-MM-DD-<slug>.md");
    }
    const path = join(JOURNAL_DIR, input.name);
    try {
      const [markdown, stat] = await Promise.all([fs.readFile(path, "utf8"), fs.stat(path)]);
      return { name: input.name, markdown, mtime: stat.mtime.toISOString() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ClientError(`journal not found: ${input.name}`, undefined, 404);
      }
      throw err;
    }
  },

  async reassess(input) {
    const sym = normalizeSymbol(input.sym);
    const model = aiConfig().analystModel;
    if (!model) return { started: false, reason: "analyst layer disabled" };
    const result = runAnalyst({ symbol: sym, origin: "manual", deps: { model } });
    void result.done?.catch(() => {});
    return { started: result.started, ...(result.reason ? { reason: result.reason } : {}) };
  },

  async binanceTopAnalysisStart(input = {}) {
    if (!aiConfig().analystModel) throw new ClientError("analyst layer disabled", "请先在设置中配置分析模型。", 503);
    return startBinanceTopAnalysis(input);
  },

  async binanceTopAnalysisStatus() {
    return binanceTopAnalysisState();
  },

  async binanceTopAnalysisAutomationStop() {
    return stopBinanceTopAnalysisAutomation();
  },

  async note(input) {
    const name = noteFileName(input.sym);
    const path = join(STOCKS_DIR, `${name}.md`);
    try {
      const [markdown, stat] = await Promise.all([fs.readFile(path, "utf8"), fs.stat(path)]);
      return { markdown, mtime: stat.mtime.toISOString() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { markdown: null };
      throw err;
    }
  },

  async deepDive(input) {
    const name = noteFileName(input.sym);
    return startDeepDive(name);
  },

  async deepDiveStatus(_input) {
    return deepDiveState();
  },

  async latest(input) {
    const sym = normalizeSymbol(input.sym);
    const doc = await latestIntradayDoc(sym);
    if (!doc) {
      throw new ClientError(`no intraday analysis for ${sym}`, "run intraday-signal for this symbol first", 404);
    }
    return { ...doc, url: chartUrl(doc), prediction_stale: predictionStale(doc, new Date()) };
  },
};
