import type { NewsItem, RawBar } from "../../../../shared/types.js";
import { ClientError } from "../../errors.js";
import { getLiquidationSnapshot } from "./binanceLiquidations.js";
import type {
  BinanceDerivativesSnapshot,
  BinanceInstrument,
  MarketDataProvider,
  RawQuote,
} from "./types.js";

const BASE_URL = process.env.BINANCE_FUTURES_REST_URL ?? "https://fapi.binance.com";
const TIMEOUT_MS = 12_000;
const EXCHANGE_INFO_TTL_MS = 30 * 60_000;
const PERIODS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"]);

interface ExchangeSymbol extends BinanceInstrument {}
interface ExchangeInfo { symbols: ExchangeSymbol[] }

let instrumentCache: { at: number; symbols: Map<string, BinanceInstrument> } | null = null;

async function request<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClientError(`binance ${path} failed: ${detail}`, "Check Binance availability in your region and the symbol (e.g. BTCUSDT, NVDAUSDT, XAUUSDT).", 502);
  }
}

async function instruments(): Promise<Map<string, BinanceInstrument>> {
  if (instrumentCache && Date.now() - instrumentCache.at < EXCHANGE_INFO_TTL_MS) return instrumentCache.symbols;
  const data = await request<ExchangeInfo>("/fapi/v1/exchangeInfo");
  const symbols = new Map(data.symbols.map((row) => [row.symbol, {
    symbol: row.symbol,
    contractType: row.contractType,
    status: row.status,
    marginAsset: row.marginAsset,
    quoteAsset: row.quoteAsset,
    underlyingType: row.underlyingType,
    underlyingSubType: row.underlyingSubType ?? [],
  }]));
  instrumentCache = { at: Date.now(), symbols };
  return symbols;
}

export async function getBinanceInstrument(symbol: string): Promise<BinanceInstrument> {
  const value = (await instruments()).get(symbol.toUpperCase());
  if (!value) throw new ClientError(`unknown Binance USD-M symbol: ${symbol}`, "Use a currently listed symbol such as BTCUSDT, ETHUSDT, NVDAUSDT, MUUSDT, XAUUSDT or XAGUSDT.");
  return value;
}

function num(value: unknown): number {
  return Number(value);
}

function lastOrNull<T>(rows: T[]): T | null {
  return rows.length ? rows[rows.length - 1] : null;
}

export const binanceProvider: MarketDataProvider = {
  name: "binance-usdm",
  capabilities: new Set(),

  async getKline(symbol: string, period: string, count: number): Promise<RawBar[]> {
    if (!PERIODS.has(period)) throw new ClientError(`binance kline: unsupported period "${period}"`, `supported periods: ${[...PERIODS].join(", ")}`);
    await getBinanceInstrument(symbol);
    const limit = Math.max(1, Math.min(Math.floor(count), 1500));
    const rows = await request<Array<[number, string, string, string, string, string]>>("/fapi/v1/klines", {
      symbol: symbol.toUpperCase(), interval: period, limit,
    });
    return rows.map((row) => ({
      time: new Date(row[0]).toISOString(), open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5],
    }));
  },

  async getQuotes(symbols: string[]): Promise<RawQuote[]> {
    return Promise.all(symbols.map(async (rawSymbol) => {
      const symbol = rawSymbol.toUpperCase();
      await getBinanceInstrument(symbol);
      const ticker = await request<{ lastPrice: string; priceChangePercent: string; prevClosePrice: string }>("/fapi/v1/ticker/24hr", { symbol });
      return { symbol, last: ticker.lastPrice, prev_close: ticker.prevClosePrice, change_percentage: ticker.priceChangePercent };
    }));
  },

  async getNews(_symbol: string, _limit?: number): Promise<NewsItem[]> {
    return [];
  },

  async getDerivativesSnapshot(rawSymbol: string): Promise<BinanceDerivativesSnapshot> {
    const symbol = rawSymbol.toUpperCase();
    const info = await getBinanceInstrument(symbol);
    const [markResult, oiResult, fundingResult, oiHistoryResult, globalResult, topAccountsResult, topPositionsResult, takerResult, depthResult, tradesResult] = await Promise.allSettled([
      request<{ markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number }>("/fapi/v1/premiumIndex", { symbol }),
      request<{ openInterest: string; time: number }>("/fapi/v1/openInterest", { symbol }),
      request<Array<{ fundingRate: string; fundingTime: number }>>("/fapi/v1/fundingRate", { symbol, limit: 20 }),
      request<Array<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }>>("/futures/data/openInterestHist", { symbol, period: "5m", limit: 30 }),
      request<Array<{ longShortRatio: string; longAccount: string; shortAccount: string }>>("/futures/data/globalLongShortAccountRatio", { symbol, period: "5m", limit: 1 }),
      request<Array<{ longShortRatio: string; longAccount: string; shortAccount: string }>>("/futures/data/topLongShortAccountRatio", { symbol, period: "5m", limit: 1 }),
      request<Array<{ longShortRatio: string; longAccount: string; shortAccount: string }>>("/futures/data/topLongShortPositionRatio", { symbol, period: "5m", limit: 1 }),
      request<Array<{ buySellRatio: string; buyVol: string; sellVol: string }>>("/futures/data/takerlongshortRatio", { symbol, period: "5m", limit: 1 }),
      request<{ lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }>("/fapi/v1/depth", { symbol, limit: 20 }),
      request<Array<{ p: string; q: string; m: boolean; T: number }>>("/fapi/v1/aggTrades", { symbol, limit: 50 }),
    ]);
    const fulfilled = <T>(result: PromiseSettledResult<T>): T | null => result.status === "fulfilled" ? result.value : null;
    const ratio = (row: { longShortRatio: string; longAccount: string; shortAccount: string } | null) => row ? {
      longShortRatio: num(row.longShortRatio), longAccount: num(row.longAccount), shortAccount: num(row.shortAccount),
    } : null;
    const mark = fulfilled(markResult);
    const oi = fulfilled(oiResult);
    const oiHistory = fulfilled(oiHistoryResult) ?? [];
    const latestOi = lastOrNull(oiHistory);
    const depth = fulfilled(depthResult);
    const taker = lastOrNull(fulfilled(takerResult) ?? []);
    const liquidation = getLiquidationSnapshot(symbol);
    return {
      instrument: info,
      mark: mark ? { markPrice: num(mark.markPrice), indexPrice: num(mark.indexPrice), lastFundingRate: num(mark.lastFundingRate), nextFundingTime: new Date(mark.nextFundingTime).toISOString() } : null,
      openInterest: oi ? { contracts: num(oi.openInterest), notional: latestOi ? num(latestOi.sumOpenInterestValue) : null, time: new Date(oi.time).toISOString() } : null,
      fundingHistory: (fulfilled(fundingResult) ?? []).map((row) => ({ rate: num(row.fundingRate), time: new Date(row.fundingTime).toISOString() })),
      openInterestHistory: oiHistory.map((row) => ({ contracts: num(row.sumOpenInterest), value: num(row.sumOpenInterestValue), time: new Date(row.timestamp).toISOString() })),
      sentiment: {
        globalAccounts: ratio(lastOrNull(fulfilled(globalResult) ?? [])),
        topAccounts: ratio(lastOrNull(fulfilled(topAccountsResult) ?? [])),
        topPositions: ratio(lastOrNull(fulfilled(topPositionsResult) ?? [])),
        taker: taker ? { buySellRatio: num(taker.buySellRatio), buyVolume: num(taker.buyVol), sellVolume: num(taker.sellVol) } : null,
      },
      depth: depth ? { lastUpdateId: depth.lastUpdateId, bids: depth.bids.map(([p, q]) => [num(p), num(q)]), asks: depth.asks.map(([p, q]) => [num(p), num(q)]) } : null,
      recentTrades: (fulfilled(tradesResult) ?? []).map((row) => ({ price: num(row.p), quantity: num(row.q), buyerMaker: row.m, time: new Date(row.T).toISOString() })),
      liquidations: liquidation.rows,
      liquidationCoverageStartedAt: liquidation.coverageStartedAt,
    };
  },
};
