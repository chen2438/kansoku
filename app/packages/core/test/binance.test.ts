import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/marketdata/binanceLiquidations.js", () => ({
  getLiquidationSnapshot: () => ({ rows: [], coverageStartedAt: "2026-07-11T00:00:00.000Z" }),
}));
const { binanceProvider } = await import("../src/services/marketdata/binance.js");
const instrument = { symbol: "BTCUSDT", contractType: "PERPETUAL", status: "TRADING", marginAsset: "USDT", quoteAsset: "USDT", underlyingType: "COIN", underlyingSubType: [] };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("Binance USD-M provider", () => {
  it("normalizes exchange klines", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => String(input).includes("exchangeInfo") ? json({ symbols: [instrument] }) : json([[1_700_000_000_000, "100", "110", "90", "105", "12"]])));
    expect(await binanceProvider.getKline("BTCUSDT", "5m", 1)).toEqual([{ time: "2023-11-14T22:13:20.000Z", open: "100", high: "110", low: "90", close: "105", volume: "12" }]);
  });

  it("assembles mark, OI, sentiment, depth and trades", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("premiumIndex")) return json({ markPrice: "101", indexPrice: "100", lastFundingRate: "0.0001", nextFundingTime: 1_700_000_000_000 });
      if (path.endsWith("openInterest")) return json({ openInterest: "123", time: 1_700_000_000_000 });
      if (path.endsWith("fundingRate")) return json([{ fundingRate: "0.0001", fundingTime: 1_700_000_000_000 }]);
      if (path.endsWith("openInterestHist")) return json([{ sumOpenInterest: "123", sumOpenInterestValue: "12300", timestamp: 1_700_000_000_000 }]);
      if (path.includes("LongShort")) return json([{ longShortRatio: "1.5", longAccount: "0.6", shortAccount: "0.4" }]);
      if (path.endsWith("takerlongshortRatio")) return json([{ buySellRatio: "2", buyVol: "20", sellVol: "10" }]);
      if (path.endsWith("depth")) return json({ lastUpdateId: 1, bids: [["100", "2"]], asks: [["101", "3"]] });
      if (path.endsWith("aggTrades")) return json([{ p: "100.5", q: "4", m: true, T: 1_700_000_000_000 }]);
      return json({ symbols: [instrument] });
    }));
    const data = await binanceProvider.getDerivativesSnapshot!("BTCUSDT");
    expect(data.mark?.markPrice).toBe(101); expect(data.openInterest?.notional).toBe(12300);
    expect(data.sentiment.globalAccounts?.longShortRatio).toBe(1.5); expect(data.depth?.bids[0]).toEqual([100, 2]);
    expect(data.recentTrades[0].buyerMaker).toBe(true);
  });
});
