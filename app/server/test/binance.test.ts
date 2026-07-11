import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/marketdata/binanceLiquidations.js", () => ({
  getLiquidationSnapshot: () => ({
    rows: [{ side: "SELL", price: 100, averagePrice: 99, quantity: 2, status: "FILLED", time: "2026-07-11T00:00:00.000Z" }],
    coverageStartedAt: "2026-07-11T00:00:00.000Z",
  }),
}));

const { binanceProvider } = await import("../src/services/marketdata/binance.js");

const instrument = {
  symbol: "BTCUSDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  marginAsset: "USDT",
  quoteAsset: "USDT",
  underlyingType: "COIN",
  underlyingSubType: ["PoW"],
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("Binance USD-M provider", () => {
  it("normalizes Binance klines to RawBar", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("exchangeInfo")) return json({ symbols: [instrument] });
      if (url.includes("/klines")) return json([[1_700_000_000_000, "100", "110", "90", "105", "12"]]);
      throw new Error(`unexpected URL ${url}`);
    }));
    const bars = await binanceProvider.getKline("BTCUSDT", "5m", 1);
    expect(bars).toEqual([{ time: "2023-11-14T22:13:20.000Z", open: "100", high: "110", low: "90", close: "105", volume: "12" }]);
  });

  it("assembles derivative structure, order flow and liquidation coverage", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("exchangeInfo")) return json({ symbols: [instrument] });
      if (url.pathname.endsWith("premiumIndex")) return json({ markPrice: "101", indexPrice: "100", lastFundingRate: "0.0001", nextFundingTime: 1_700_000_000_000 });
      if (url.pathname.endsWith("openInterest")) return json({ openInterest: "123", time: 1_700_000_000_000 });
      if (url.pathname.endsWith("fundingRate")) return json([{ fundingRate: "0.0001", fundingTime: 1_700_000_000_000 }]);
      if (url.pathname.endsWith("openInterestHist")) return json([{ sumOpenInterest: "123", sumOpenInterestValue: "12300", timestamp: 1_700_000_000_000 }]);
      if (url.pathname.includes("LongShort")) return json([{ longShortRatio: "1.5", longAccount: "0.6", shortAccount: "0.4" }]);
      if (url.pathname.endsWith("takerlongshortRatio")) return json([{ buySellRatio: "2", buyVol: "20", sellVol: "10" }]);
      if (url.pathname.endsWith("depth")) return json({ lastUpdateId: 1, bids: [["100", "2"]], asks: [["101", "3"]] });
      if (url.pathname.endsWith("aggTrades")) return json([{ p: "100.5", q: "4", m: true, T: 1_700_000_000_000 }]);
      throw new Error(`unexpected URL ${url}`);
    }));
    const snapshot = await binanceProvider.getDerivativesSnapshot!("BTCUSDT");
    expect(snapshot.instrument.contractType).toBe("PERPETUAL");
    expect(snapshot.mark?.markPrice).toBe(101);
    expect(snapshot.openInterest?.notional).toBe(12300);
    expect(snapshot.sentiment.globalAccounts?.longShortRatio).toBe(1.5);
    expect(snapshot.sentiment.taker?.buySellRatio).toBe(2);
    expect(snapshot.depth?.bids).toEqual([[100, 2]]);
    expect(snapshot.recentTrades[0].buyerMaker).toBe(true);
    expect(snapshot.liquidations).toHaveLength(1);
    expect(snapshot.liquidationCoverageStartedAt).toBe("2026-07-11T00:00:00.000Z");
  });
});
