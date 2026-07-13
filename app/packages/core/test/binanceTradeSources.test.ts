import { describe, expect, it } from "vitest";
import type { BinanceClosedPositionHistory, BinancePositionRow } from "../src/contract/binanceAccount.js";
import {
  applyBinancePositionSources,
  applyBinanceTradeSources,
  type BinanceTradeSourceRecord,
} from "../src/modules/binanceAccount/binanceAccount.service.js";

const records: BinanceTradeSourceRecord[] = [
  { symbol: "BTCUSDT", direction: "long", source: "volume_top20", entryOrderId: 1, openedAt: 100 },
  { symbol: "BTCUSDT", direction: "long", source: "gainers_top10", entryOrderId: 2, openedAt: 150 },
  { symbol: "ETHUSDT", direction: "short", source: "losers_top10", entryOrderId: 3, openedAt: 300 },
];

const history: BinanceClosedPositionHistory = {
  from: 0,
  to: 1_000,
  rows: [{
    id: "btc-close",
    symbol: "BTCUSDT",
    asset: "USDT",
    realizedPnl: 5,
    commission: -0.2,
    fundingFee: 0,
    otherAdjustments: 0,
    netPnl: 4.8,
    closedAt: 200,
    closeCount: 2,
    direction: "long",
    source: "unknown",
    tradeId: null,
    transactionId: 10,
  }],
};

describe("Binance 交易来源", () => {
  it("把开仓来源写入对应平仓，并支持一分钟组合的混合来源", () => {
    const result = applyBinanceTradeSources(records, history);
    expect(result.history.rows[0].source).toBe("mixed");
    expect(result.records.slice(0, 2).every((record) => record.closedAt === 200)).toBe(true);
    expect(result.records[2].closedAt).toBeUndefined();
  });

  it("把尚未平仓的最新来源写入当前持仓", () => {
    const positions: BinancePositionRow[] = [{
      symbol: "ETHUSDT",
      side: "short",
      positionAmt: -1,
      entryPrice: 100,
      breakEvenPrice: 101,
      markPrice: 90,
      unrealizedPnl: 10,
      netUnrealizedPnl: 9,
      netUnrealizedPnlIncludesCosts: true,
      leverage: 20,
      liquidationPrice: 120,
      source: "unknown",
    }];
    expect(applyBinancePositionSources(records, positions)[0].source).toBe("losers_top10");
  });
});
