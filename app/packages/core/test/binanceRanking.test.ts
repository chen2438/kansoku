import { describe, expect, it } from "vitest";
import { rankBinancePerpetuals, type BinanceVolumeLeader } from "../src/services/marketdata/binance.js";

const rows: BinanceVolumeLeader[] = [
  { symbol: "AAAUSDT", lastPrice: 1, changePercent: 12, quoteVolume: 100 },
  { symbol: "BBBUSDT", lastPrice: 1, changePercent: -8, quoteVolume: 500 },
  { symbol: "CCCUSDT", lastPrice: 1, changePercent: 4, quoteVolume: 1_000 },
  { symbol: "DDDUSDT", lastPrice: 1, changePercent: -20, quoteVolume: 50 },
];

describe("Binance 永续合约榜单排序", () => {
  it("按 24 小时涨幅从高到低选取", () => {
    expect(rankBinancePerpetuals(rows, "gainers_top10", 3).map((row) => row.symbol))
      .toEqual(["AAAUSDT", "CCCUSDT", "BBBUSDT"]);
  });

  it("按 24 小时跌幅从低到高选取", () => {
    expect(rankBinancePerpetuals(rows, "losers_top10", 3).map((row) => row.symbol))
      .toEqual(["DDDUSDT", "BBBUSDT", "CCCUSDT"]);
  });

  it("成交额榜仍按成交额从高到低选取", () => {
    expect(rankBinancePerpetuals(rows, "volume_top20", 2).map((row) => row.symbol))
      .toEqual(["CCCUSDT", "BBBUSDT"]);
  });
});
