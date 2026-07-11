import type { NewsItem, RawBar } from "../../../../../shared/types.js";
import { ClientError } from "../../errors.js";
import { getLiquidationSnapshot } from "./binanceLiquidations.js";
import type { BinanceDerivativesSnapshot, BinanceInstrument, MarketDataProvider, RatioSnapshot, RawQuote } from "./types.js";

const BASE = process.env.BINANCE_FUTURES_REST_URL ?? "https://fapi.binance.com";
const PERIODS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"]);
let infoCache: { at: number; rows: Map<string, BinanceInstrument> } | null = null;

async function request<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return await response.json() as T;
  } catch (error) {
    throw new ClientError(`binance ${path} failed: ${error instanceof Error ? error.message : String(error)}`, "Check Binance availability and the USD-M symbol.", 502);
  }
}

export async function getBinanceInstrument(raw: string): Promise<BinanceInstrument> {
  if (!infoCache || Date.now() - infoCache.at > 30 * 60_000) {
    const data = await request<{ symbols: BinanceInstrument[] }>("/fapi/v1/exchangeInfo");
    infoCache = { at: Date.now(), rows: new Map(data.symbols.map((row) => [row.symbol, { ...row, underlyingSubType: row.underlyingSubType ?? [] }])) };
  }
  const row = infoCache.rows.get(raw.toUpperCase());
  if (!row) throw new ClientError(`unknown Binance USD-M symbol: ${raw}`, "Try BTCUSDT, ETHUSDT, NVDAUSDT, XAUUSDT or another listed USD-M contract.", 404);
  return row;
}

const n = (value: unknown) => Number(value);
const last = <T>(rows: T[]) => rows.length ? rows[rows.length - 1] : null;
const ok = <T>(result: PromiseSettledResult<T>): T | null => result.status === "fulfilled" ? result.value : null;
const ratio = (row: { longShortRatio: string; longAccount: string; shortAccount: string } | null): RatioSnapshot | null => row ? ({ longShortRatio: n(row.longShortRatio), longAccount: n(row.longAccount), shortAccount: n(row.shortAccount) }) : null;

export const binanceProvider: MarketDataProvider = {
  name: "binance-usdm", capabilities: new Set(),
  async getKline(raw, period, count): Promise<RawBar[]> {
    const symbol = raw.toUpperCase(); await getBinanceInstrument(symbol);
    if (!PERIODS.has(period)) throw new ClientError(`unsupported Binance kline period: ${period}`);
    const rows = await request<Array<[number, string, string, string, string, string]>>("/fapi/v1/klines", { symbol, interval: period, limit: Math.min(1500, Math.max(1, Math.floor(count))) });
    return rows.map((r) => ({ time: new Date(r[0]).toISOString(), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
  },
  async getQuotes(symbols): Promise<RawQuote[]> {
    return Promise.all(symbols.map(async (raw) => {
      const symbol = raw.toUpperCase(); await getBinanceInstrument(symbol);
      const t = await request<{ lastPrice: string; prevClosePrice: string; priceChangePercent: string }>("/fapi/v1/ticker/24hr", { symbol });
      return { symbol, last: t.lastPrice, prev_close: t.prevClosePrice, change_percentage: t.priceChangePercent };
    }));
  },
  async getNews(_symbol, _limit): Promise<NewsItem[]> { return []; },
  async getDerivativesSnapshot(raw): Promise<BinanceDerivativesSnapshot> {
    const symbol = raw.toUpperCase(); const instrument = await getBinanceInstrument(symbol);
    const results = await Promise.allSettled([
      request<any>("/fapi/v1/premiumIndex", { symbol }), request<any>("/fapi/v1/openInterest", { symbol }),
      request<any[]>("/fapi/v1/fundingRate", { symbol, limit: 20 }), request<any[]>("/futures/data/openInterestHist", { symbol, period: "5m", limit: 30 }),
      request<any[]>("/futures/data/globalLongShortAccountRatio", { symbol, period: "5m", limit: 1 }), request<any[]>("/futures/data/topLongShortAccountRatio", { symbol, period: "5m", limit: 1 }),
      request<any[]>("/futures/data/topLongShortPositionRatio", { symbol, period: "5m", limit: 1 }), request<any[]>("/futures/data/takerlongshortRatio", { symbol, period: "5m", limit: 1 }),
      request<any>("/fapi/v1/depth", { symbol, limit: 20 }), request<any[]>("/fapi/v1/aggTrades", { symbol, limit: 50 }),
    ]);
    const [mark, oi, funding, oiHist, global, topAccounts, topPositions, takerRows, depth, trades] = results.map(ok) as any[];
    const latestOi = last(oiHist ?? []) as any; const taker = last(takerRows ?? []) as any; const liq = getLiquidationSnapshot(symbol);
    return {
      instrument,
      mark: mark ? { markPrice: n(mark.markPrice), indexPrice: n(mark.indexPrice), lastFundingRate: n(mark.lastFundingRate), nextFundingTime: new Date(mark.nextFundingTime).toISOString() } : null,
      openInterest: oi ? { contracts: n(oi.openInterest), notional: latestOi ? n(latestOi.sumOpenInterestValue) : null, time: new Date(oi.time).toISOString() } : null,
      fundingHistory: (funding ?? []).map((r: any) => ({ rate: n(r.fundingRate), time: new Date(r.fundingTime).toISOString() })),
      openInterestHistory: (oiHist ?? []).map((r: any) => ({ contracts: n(r.sumOpenInterest), value: n(r.sumOpenInterestValue), time: new Date(r.timestamp).toISOString() })),
      sentiment: { globalAccounts: ratio(last(global ?? [])), topAccounts: ratio(last(topAccounts ?? [])), topPositions: ratio(last(topPositions ?? [])), taker: taker ? { buySellRatio: n(taker.buySellRatio), buyVolume: n(taker.buyVol), sellVolume: n(taker.sellVol) } : null },
      depth: depth ? { lastUpdateId: depth.lastUpdateId, bids: depth.bids.map(([p,q]: string[]) => [n(p),n(q)]), asks: depth.asks.map(([p,q]: string[]) => [n(p),n(q)]) } : null,
      recentTrades: (trades ?? []).map((r: any) => ({ price: n(r.p), quantity: n(r.q), buyerMaker: r.m, time: new Date(r.T).toISOString() })),
      liquidations: liq.rows, liquidationCoverageStartedAt: liq.coverageStartedAt,
    };
  },
};
