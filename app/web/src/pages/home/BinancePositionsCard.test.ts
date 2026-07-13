import { describe, expect, it } from "vitest";
import type { BinanceClosedPositionHistory } from "../../../../packages/core/src/contract/index.js";
import { groupClosedTrades } from "./BinancePositionsCard.js";

type ClosedTrade = BinanceClosedPositionHistory["rows"][number];

function trade(input: Partial<ClosedTrade> & Pick<ClosedTrade, "id" | "symbol" | "closedAt">): ClosedTrade {
  return {
    asset: "USDT",
    realizedPnl: 0,
    commission: 0,
    fundingFee: 0,
    otherAdjustments: 0,
    netPnl: 0,
    closeCount: 1,
    direction: "unknown",
    source: "unknown",
    tradeId: null,
    transactionId: null,
    ...input,
  };
}

describe("Binance 历史平仓按合约汇总", () => {
  it("合并同一合约的净盈亏，并保留一分钟分组后的细目", () => {
    const groups = groupClosedTrades([
      trade({ id: "btc-new", symbol: "BTCUSDT", closedAt: 300, realizedPnl: 3, commission: -0.2, netPnl: 2.8, closeCount: 2 }),
      trade({ id: "eth", symbol: "ETHUSDT", closedAt: 400, realizedPnl: -1, commission: -0.1, netPnl: -1.1 }),
      trade({ id: "btc-old", symbol: "BTCUSDT", closedAt: 100, realizedPnl: 2, fundingFee: -0.1, netPnl: 1.9 }),
    ]);

    expect(groups.map((group) => group.symbol)).toEqual(["ETHUSDT", "BTCUSDT"]);
    expect(groups[1]).toMatchObject({
      realizedPnl: 5,
      feeAdjustments: -0.3,
      netPnl: 4.7,
      latestClosedAt: 300,
      closeCount: 3,
      wins: 2,
      losses: 0,
      winRate: 1,
    });
    expect(groups[1].rows.map((row) => row.id)).toEqual(["btc-new", "btc-old"]);
  });

  it("按一分钟合并组计算胜率，净盈亏为零不计入胜负", () => {
    const [group] = groupClosedTrades([
      trade({ id: "win", symbol: "XRPUSDT", closedAt: 300, netPnl: 1 }),
      trade({ id: "flat", symbol: "XRPUSDT", closedAt: 200, netPnl: 0 }),
      trade({ id: "loss", symbol: "XRPUSDT", closedAt: 100, netPnl: -1 }),
    ]);
    expect(group).toMatchObject({ wins: 1, losses: 1, winRate: 0.5 });
  });
});
