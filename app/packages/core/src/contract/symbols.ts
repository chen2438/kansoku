import type {
  BenchmarkSeries,
  ChartDoc,
  CockpitComment,
  CockpitFlow,
  CockpitPosition,
  RelativeVolume,
  SymbolAnalysisRow,
} from "../../../../shared/types.js";
import type { DeepDiveState } from "../ai/deepDive.js";
import type { BinanceDerivativesSnapshot } from "../services/marketdata/types.js";
import { defineRoutes } from "./defineRoutes.js";

export interface JournalListRow {
  name: string;
  date: string;
}

export interface JournalEntry {
  name: string;
  markdown: string;
  mtime: string;
}

export interface NoteResult {
  markdown: string | null;
  mtime?: string;
}

export type ReassessResult = { started: boolean; reason?: string };

export type BinanceBatchItemStatus = "queued" | "running" | "completed" | "failed";
export interface BinanceBatchItem {
  symbol: string;
  rank: number;
  quoteVolume: number;
  changePercent: number;
  status: BinanceBatchItemStatus;
  chartId?: string;
  // 完成后带上分析结论，供列表显示"做多（待触发/已触发）/做空/观望"而非"完成"。
  direction?: "long" | "short" | "neutral";
  entryStatus?: "waiting" | "triggered" | "invalidated" | "stopped" | null;
  error?: string;
}
export interface BinanceBatchState {
  id: string;
  status: "running" | "completed";
  startedAt: string;
  finishedAt?: string;
  items: BinanceBatchItem[];
}

export type DeepDiveStartResult = { started: true } | { started: false; reason: "busy" | "disabled" };
export interface SymbolValidation {
  symbol: string; provider: "longbridge" | "binance-usdm"; source: string; marketType: string;
  contractType?: string; underlyingType?: string;
}

export interface LatestChart extends ChartDoc {
  url: string;
  prediction_stale: boolean;
}

export interface SymbolsApi {
  validate(input: { sym: string }): Promise<SymbolValidation>;
  derivatives(input: { sym: string }): Promise<BinanceDerivativesSnapshot>;
  flow(input: { sym: string }): Promise<CockpitFlow | null>;
  benchmark(input: { sym: string }): Promise<BenchmarkSeries[]>;
  position(input: { sym: string }): Promise<CockpitPosition | null>;
  analyses(input: { sym: string }): Promise<SymbolAnalysisRow[]>;
  relvol(input: { sym: string }): Promise<RelativeVolume | null>;
  comments(input: { sym: string; date?: string }): Promise<CockpitComment[]>;
  commentDates(input: { sym: string }): Promise<string[]>;
  journal(input: { sym: string }): Promise<JournalListRow[]>;
  journalEntry(input: { sym: string; name: string }): Promise<JournalEntry>;
  reassess(input: { sym: string }): Promise<ReassessResult>;
  binanceTopAnalysisStart(input?: Record<string, never>): Promise<BinanceBatchState>;
  binanceTopAnalysisStatus(input?: Record<string, never>): Promise<BinanceBatchState | null>;
  note(input: { sym: string }): Promise<NoteResult>;
  deepDive(input: { sym: string }): Promise<DeepDiveStartResult>;
  deepDiveStatus(input: { sym: string }): Promise<DeepDiveState>;
  latest(input: { sym: string }): Promise<LatestChart>;
}

export const symbolsRoutes = defineRoutes<SymbolsApi>("symbols", {
  validate: { method: "GET", path: "/:sym/validate" },
  derivatives: { method: "GET", path: "/:sym/derivatives" },
  flow: { method: "GET", path: "/:sym/flow" },
  benchmark: { method: "GET", path: "/:sym/benchmark" },
  position: { method: "GET", path: "/:sym/position" },
  analyses: { method: "GET", path: "/:sym/analyses" },
  relvol: { method: "GET", path: "/:sym/relvol" },
  comments: { method: "GET", path: "/:sym/comments" },
  commentDates: { method: "GET", path: "/:sym/comment-dates" },
  journal: { method: "GET", path: "/:sym/journal" },
  journalEntry: { method: "GET", path: "/:sym/journal/:name" },
  reassess: { method: "POST", path: "/:sym/reassess" },
  binanceTopAnalysisStart: { method: "POST", path: "/binance/top-volume-analysis" },
  binanceTopAnalysisStatus: { method: "GET", path: "/binance/top-volume-analysis/status" },
  note: { method: "GET", path: "/:sym/note", raw: "body" },
  deepDive: { method: "POST", path: "/:sym/deep-dive", raw: "body" },
  deepDiveStatus: { method: "GET", path: "/:sym/deep-dive/status", raw: "body" },
  latest: { method: "GET", path: "/:sym/latest" },
});
