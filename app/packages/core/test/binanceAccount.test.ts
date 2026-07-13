import { describe, expect, it, vi } from "vitest";
import {
  binanceCancelTestnetOrder,
  binanceClosedPositionHistory,
  binanceCloseAllTestnetPositions,
  binanceCloseTestnetPosition,
  binancePlaceTestnetOrder,
  binancePositions,
  listBinanceClosedPositionTrades,
  signQuery,
} from "../src/services/marketdata/binanceAccount.js";

describe("binance account signing", () => {
  // Binance 官方文档的已知示例（HMAC-SHA256），用来锁定签名算法正确。
  it("matches the documented HMAC-SHA256 example", () => {
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const query =
      "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(signQuery(secret, query)).toBe("c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });

  it("is deterministic and secret-sensitive", () => {
    const q = "timestamp=1700000000000&recvWindow=5000";
    expect(signQuery("abc", q)).toBe(signQuery("abc", q));
    expect(signQuery("abc", q)).not.toBe(signQuery("abd", q));
  });
});

describe("binance closed-position history", () => {
  it("merges same-symbol closes within one minute, allocates fees, and sorts newest first", () => {
    const rows = listBinanceClosedPositionTrades([
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "REALIZED_PNL", income: "10", time: 100, tranId: 1, tradeId: "btc-1" },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "COMMISSION", income: "-0.5", time: 50, tranId: 2 },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "COMMISSION", income: "-0.4", time: 100, tranId: 3, tradeId: "btc-1" },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "FUNDING_FEE", income: "-0.1", time: 80, tranId: 4 },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "COMMISSION_REBATE", income: "0.05", time: 110, tranId: 5, tradeId: "btc-1" },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "INSURANCE_CLEAR", income: "-0.25", time: 100, tranId: 6 },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "TRANSFER", income: "1000", time: 120, tranId: 7 },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "REALIZED_PNL", income: "3", time: 150, tranId: 8, tradeId: "btc-2" },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "COMMISSION", income: "-0.2", time: 150, tranId: 9, tradeId: "btc-2" },
      { symbol: "ETHUSDT", asset: "USDT", incomeType: "REALIZED_PNL", income: "-2", time: 200, tranId: 10, tradeId: "eth-1" },
      { symbol: "ETHUSDT", asset: "USDT", incomeType: "COMMISSION", income: "-0.2", time: 200, tranId: 11, tradeId: "eth-1" },
      { symbol: "XRPUSDT", asset: "USDT", incomeType: "COMMISSION", income: "-0.1", time: 300, tranId: 10 },
    ], new Map([
      ["BTCUSDT:btc-1", "long" as const],
      ["BTCUSDT:btc-2", "short" as const],
      ["ETHUSDT:eth-1", "short" as const],
    ]));

    expect(rows).toEqual([
      expect.objectContaining({
        symbol: "ETHUSDT", realizedPnl: -2, commission: -0.2, fundingFee: 0,
        otherAdjustments: 0, netPnl: -2.2, closedAt: 200, closeCount: 1, direction: "short", tradeId: "eth-1",
      }),
      expect.objectContaining({
        symbol: "BTCUSDT", realizedPnl: 13, commission: -1.1, fundingFee: -0.1,
        otherAdjustments: -0.2, netPnl: 11.6, closedAt: 150, closeCount: 2, direction: "mixed", tradeId: null,
      }),
    ]);
  });

  it("keeps same-symbol closes separate when adjacent closes are over one minute apart", () => {
    const rows = listBinanceClosedPositionTrades([
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "REALIZED_PNL", income: "1", time: 100_000, tranId: 1 },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "REALIZED_PNL", income: "2", time: 160_000, tranId: 2 },
      { symbol: "BTCUSDT", asset: "USDT", incomeType: "REALIZED_PNL", income: "3", time: 220_001, tranId: 3 },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ realizedPnl: 3, closedAt: 220_001, closeCount: 1 });
    expect(rows[1]).toMatchObject({ realizedPnl: 3, closedAt: 160_000, closeCount: 2 });
  });

  it("requests the full 90-day income window with Binance pagination", async () => {
    const now = Date.UTC(2026, 6, 13);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/fapi/v1/userTrades") {
        return Response.json([{ symbol: "BTCUSDT", id: 123, side: "SELL", positionSide: "BOTH" }]);
      }
      return Response.json([
        { symbol: "BTCUSDT", asset: "USDT", incomeType: "REALIZED_PNL", income: "1.2", time: now - 1_000, tranId: 1, tradeId: "123" },
        { symbol: "BTCUSDT", asset: "USDT", incomeType: "COMMISSION", income: "-0.2", time: now - 1_000, tranId: 2, tradeId: "123" },
      ]);
    });

    const result = await binanceClosedPositionHistory(
      { apiKey: "test-key", apiSecret: "test-secret", testnet: true },
      fetchMock as unknown as typeof fetch,
      now,
    );

    expect(result).toMatchObject({ from: now - 90 * 24 * 60 * 60 * 1000, to: now });
    expect(result.rows[0]).toMatchObject({
      symbol: "BTCUSDT", realizedPnl: 1.2, commission: -0.2, netPnl: 1, closedAt: now - 1_000, direction: "long",
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/fapi/v1/income");
    expect(url.searchParams.get("startTime")).toBe(String(result.from));
    expect(url.searchParams.get("endTime")).toBe(String(now));
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("1000");
    const tradeUrl = new URL(String(fetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname === "/fapi/v1/userTrades")?.[0]));
    expect(tradeUrl.searchParams.get("symbol")).toBe("BTCUSDT");
    expect(tradeUrl.searchParams.get("fromId")).toBe("123");
  });
});

describe("binance current-position net PnL", () => {
  it("calculates long and short PnL from Binance break-even prices", async () => {
    const fetchMock = vi.fn(async () => Response.json([
      {
        symbol: "BTCUSDT", positionAmt: "2", positionSide: "BOTH", entryPrice: "100",
        breakEvenPrice: "101", markPrice: "105", unRealizedProfit: "10", leverage: "10", liquidationPrice: "50",
      },
      {
        symbol: "ETHUSDT", positionAmt: "-3", positionSide: "BOTH", entryPrice: "198",
        breakEvenPrice: "200", markPrice: "190", unRealizedProfit: "25", leverage: "5", liquidationPrice: "250",
      },
      {
        symbol: "XRPUSDT", positionAmt: "4", positionSide: "BOTH", entryPrice: "1",
        breakEvenPrice: "0", markPrice: "1.1", unRealizedProfit: "0.4", leverage: "3", liquidationPrice: "0.5",
      },
    ]));

    const positions = await binancePositions(
      { apiKey: "test-key", apiSecret: "test-secret", testnet: true },
      fetchMock as unknown as typeof fetch,
    );

    expect(positions[0]).toMatchObject({
      symbol: "BTCUSDT", breakEvenPrice: 101, netUnrealizedPnl: 8, netUnrealizedPnlIncludesCosts: true,
    });
    expect(positions[1]).toMatchObject({
      symbol: "ETHUSDT", breakEvenPrice: 200, netUnrealizedPnl: 30, netUnrealizedPnlIncludesCosts: true,
    });
    expect(positions[2]).toMatchObject({
      symbol: "XRPUSDT", netUnrealizedPnl: 0.4, netUnrealizedPnlIncludesCosts: false,
    });
  });
});

describe("binance testnet order", () => {
  const testnetCreds = { apiKey: "test-key", apiSecret: "test-secret", testnet: true };
  const validInput = {
    symbol: "BTCUSDT",
    direction: "LONG" as const,
    initialMargin: 20,
    leverage: 10,
    takeProfitPrice: 55_000,
    stopLossPrice: 45_000,
    confirmed: true,
  };

  it("hard-blocks mainnet orders before sending a request", async () => {
    const fetchMock = vi.fn();
    await expect(
      binancePlaceTestnetOrder(
        { ...testnetCreds, testnet: false },
        validInput,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "BINANCE_MAINNET_ORDER_BLOCKED", status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an explicit manual-confirmation flag", async () => {
    await expect(
      binancePlaceTestnetOrder(testnetCreds, {
        ...validInput,
        confirmed: false,
      }),
    ).rejects.toMatchObject({ code: "BINANCE_ORDER_NOT_CONFIRMED", status: 400 });
  });

  it("skips an automatic order when a live position already exists", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/positionRisk")) {
        return Response.json([{ symbol: "BTCUSDT", positionAmt: "0.003", positionSide: "BOTH" }]);
      }
      if (url.includes("/openOrders") || url.includes("/openAlgoOrders")) return Response.json([]);
      return new Response("unexpected", { status: 500 });
    });

    await expect(binancePlaceTestnetOrder(
      testnetCreds,
      { ...validInput, requireFlat: true, clientOrderId: "k-batch-1-btcusdt" },
      fetchMock as unknown as typeof fetch,
    )).rejects.toMatchObject({
      code: "BINANCE_EXISTING_EXPOSURE",
      status: 409,
      message: expect.stringContaining("已有多仓"),
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/premiumIndex"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/fapi/v1/order"))).toBe(false);
  });

  it("skips an automatic order when a normal or conditional order already exists", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/positionRisk") || url.includes("/openOrders")) return Response.json([]);
      if (url.includes("/openAlgoOrders")) return Response.json({ symbol: "BTCUSDT", algoId: 900 });
      return new Response("unexpected", { status: 500 });
    });

    await expect(binancePlaceTestnetOrder(
      testnetCreds,
      { ...validInput, requireFlat: true, clientOrderId: "k-batch-1-btcusdt" },
      fetchMock as unknown as typeof fetch,
    )).rejects.toMatchObject({
      code: "BINANCE_EXISTING_EXPOSURE",
      message: expect.stringContaining("1 个条件单"),
    });
  });

  it("sets leverage, opens by calculated quantity, then places take-profit and stop-loss", async () => {
    let nextAlgoId = 900;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/premiumIndex")) return Response.json({ markPrice: "50000" });
      if (url.includes("/exchangeInfo")) {
        return Response.json({
          symbols: [{
            symbol: "BTCUSDT",
            filters: [
              { filterType: "MARKET_LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
              { filterType: "MIN_NOTIONAL", notional: "5" },
            ],
          }],
        });
      }
      if (url.includes("/positionSide/dual")) return Response.json({ dualSidePosition: false });
      if (url.endsWith("/fapi/v1/leverage")) return Response.json({ symbol: "BTCUSDT", leverage: 10 });
      if (url.endsWith("/fapi/v1/order") && init?.method === "POST") {
        return Response.json({
          symbol: "BTCUSDT", orderId: 123, clientOrderId: "entry", side: "BUY", type: "MARKET",
          status: "FILLED", origQty: "0.004", executedQty: "0.004", avgPrice: "50100", updateTime: 1700000000000,
        });
      }
      if (url.endsWith("/fapi/v1/algoOrder")) {
        const body = new URLSearchParams(String(init?.body));
        return Response.json({
          algoId: nextAlgoId++, clientAlgoId: "protect", symbol: "BTCUSDT", side: "SELL",
          orderType: body.get("type"), algoStatus: "NEW", triggerPrice: body.get("triggerPrice"),
        });
      }
      return new Response("unexpected request", { status: 500 });
    });

    const result = await binancePlaceTestnetOrder(
      testnetCreds,
      { ...validInput, symbol: "btcusdt", clientOrderId: "k-batch-1-btcusdt" },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toMatchObject({
      direction: "LONG", initialMargin: 20, leverage: 10, referencePrice: 50_000, quantity: 0.004,
      entryOrder: { orderId: 123, symbol: "BTCUSDT", status: "FILLED", side: "BUY" },
      takeProfitOrder: { algoId: 900, type: "TAKE_PROFIT_MARKET", triggerPrice: 55_000 },
      stopLossOrder: { algoId: 901, type: "STOP_MARKET", triggerPrice: 45_000 },
      protectionErrors: [],
    });
    const requests = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
    const leverageRequest = requests.find((request) => request.url.endsWith("/fapi/v1/leverage"));
    expect(new URLSearchParams(String(leverageRequest?.init?.body)).get("leverage")).toBe("10");
    const entryRequest = requests.find((request) => request.url.endsWith("/fapi/v1/order") && request.init?.method === "POST");
    const entryBody = new URLSearchParams(String(entryRequest?.init?.body));
    expect(entryBody.get("quantity")).toBe("0.004");
    expect(entryBody.get("newClientOrderId")).toBe("k-batch-1-btcusdt");
    const protectionRequests = requests.filter((request) => request.url.endsWith("/fapi/v1/algoOrder"));
    expect(protectionRequests).toHaveLength(2);
    for (const request of protectionRequests) {
      const body = new URLSearchParams(String(request.init?.body));
      expect(body.get("side")).toBe("SELL");
      expect(body.get("closePosition")).toBe("true");
      expect(body.get("workingType")).toBe("MARK_PRICE");
      expect(body.get("clientAlgoId")).toMatch(/^k-batch-1-btcusdt-(tp|sl)$/);
      expect(body.get("signature")).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects take-profit and stop-loss prices on the wrong side before opening", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/premiumIndex")) return Response.json({ markPrice: "50000" });
      if (url.includes("/exchangeInfo")) return Response.json({ symbols: [{ symbol: "BTCUSDT", filters: [] }] });
      if (url.includes("/positionSide/dual")) return Response.json({ dualSidePosition: false });
      return new Response("unexpected", { status: 500 });
    });
    await expect(
      binancePlaceTestnetOrder(testnetCreds, { ...validInput, takeProfitPrice: 49_000 }, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("开多的止盈价必须高于当前标记价格");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/fapi/v1/order"))).toBe(false);
  });

  it("translates Binance -4411 into an actionable TradFi agreement error", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/premiumIndex")) return Response.json({ markPrice: "50000" });
      if (url.includes("/exchangeInfo")) {
        return Response.json({ symbols: [{
          symbol: "XAUUSDT",
          filters: [{ filterType: "MARKET_LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" }],
        }] });
      }
      if (url.includes("/positionSide/dual")) return Response.json({ dualSidePosition: false });
      if (url.endsWith("/fapi/v1/leverage")) return Response.json({ symbol: "XAUUSDT", leverage: 5 });
      if (url.endsWith("/fapi/v1/order") && init?.method === "POST") {
        return Response.json({ code: -4411, msg: "Please sign TradFi-Perps agreement contract first." }, { status: 400 });
      }
      return new Response("unexpected", { status: 500 });
    });

    await expect(binancePlaceTestnetOrder(
      testnetCreds,
      {
        symbol: "XAUUSDT", direction: "LONG", initialMargin: 20, leverage: 5,
        takeProfitPrice: 55_000, stopLossPrice: 45_000, confirmed: true,
      },
      fetchMock as unknown as typeof fetch,
    )).rejects.toMatchObject({
      code: "BINANCE_TRADFI_AGREEMENT_REQUIRED",
      status: 400,
      message: expect.stringContaining("尚未签署 TradFi Perps 协议"),
      hint: expect.stringContaining("本人登录"),
    });
  });

  it("re-reads a one-way position and closes its full live quantity with reduce-only", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/positionRisk")) {
        return Response.json([{ symbol: "BTCUSDT", positionAmt: "-0.0015", positionSide: "BOTH" }]);
      }
      if (url.endsWith("/fapi/v1/order") && init?.method === "POST") {
        return Response.json({
          symbol: "BTCUSDT", orderId: 456, side: "BUY", type: "MARKET", status: "FILLED",
          origQty: "0.0015", executedQty: "0.0015", avgPrice: "49900", reduceOnly: true,
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const result = await binanceCloseTestnetPosition(
      testnetCreds,
      { symbol: "btcusdt", direction: "SHORT", confirmed: true },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toMatchObject({ orderId: 456, side: "BUY", quantity: 0.0015, status: "FILLED" });
    const positionRequest = fetchMock.mock.calls.find(([url]) => String(url).includes("/positionRisk"));
    expect(String(positionRequest?.[0])).toContain("symbol=BTCUSDT");
    const closeRequest = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/fapi/v1/order") && init?.method === "POST");
    const body = new URLSearchParams(String(closeRequest?.[1]?.body));
    expect(body.get("side")).toBe("BUY");
    expect(body.get("type")).toBe("MARKET");
    expect(body.get("quantity")).toBe("0.0015");
    expect(body.get("reduceOnly")).toBe("true");
  });

  it("closes only the selected side in hedge mode", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/positionRisk")) {
        return Response.json([
          { symbol: "BTCUSDT", positionAmt: "0.002", positionSide: "LONG" },
          { symbol: "BTCUSDT", positionAmt: "-0.003", positionSide: "SHORT" },
        ]);
      }
      if (url.endsWith("/fapi/v1/order") && init?.method === "POST") {
        return Response.json({ symbol: "BTCUSDT", orderId: 457, side: "SELL", type: "MARKET", status: "FILLED", origQty: "0.002" });
      }
      return new Response("unexpected", { status: 500 });
    });

    await binanceCloseTestnetPosition(
      testnetCreds,
      { symbol: "BTCUSDT", direction: "LONG", confirmed: true },
      fetchMock as unknown as typeof fetch,
    );
    const closeRequest = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/fapi/v1/order") && init?.method === "POST");
    const body = new URLSearchParams(String(closeRequest?.[1]?.body));
    expect(body.get("side")).toBe("SELL");
    expect(body.get("quantity")).toBe("0.002");
    expect(body.get("positionSide")).toBe("LONG");
    expect(body.has("reduceOnly")).toBe(false);
  });

  it("hard-blocks mainnet market close before reading the position", async () => {
    const fetchMock = vi.fn();
    await expect(
      binanceCloseTestnetPosition(
        { ...testnetCreds, testnet: false },
        { symbol: "BTCUSDT", direction: "LONG", confirmed: true },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "BINANCE_MAINNET_ORDER_BLOCKED", status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes every live testnet position and keeps going after one failure", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/positionRisk")) {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) {
          return Response.json([
            { symbol: "BTCUSDT", positionAmt: "0.002", positionSide: "BOTH" },
            { symbol: "ETHUSDT", positionAmt: "-0.03", positionSide: "BOTH" },
          ]);
        }
        return Response.json(symbol === "BTCUSDT"
          ? [{ symbol, positionAmt: "0.002", positionSide: "BOTH" }]
          : [{ symbol, positionAmt: "-0.03", positionSide: "BOTH" }]);
      }
      if (url.pathname.endsWith("/order") && init?.method === "POST") {
        const body = new URLSearchParams(String(init.body));
        if (body.get("symbol") === "ETHUSDT") {
          return Response.json({ code: -2019, msg: "Margin is insufficient." }, { status: 400 });
        }
        return Response.json({
          symbol: "BTCUSDT", orderId: 700, side: "SELL", type: "MARKET", status: "FILLED",
          origQty: "0.002", executedQty: "0.002", avgPrice: "50000", reduceOnly: true,
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const result = await binanceCloseAllTestnetPositions(
      testnetCreds,
      { confirmed: true },
      fetchMock as unknown as typeof fetch,
    );

    expect(result.closed).toEqual([expect.objectContaining({ symbol: "BTCUSDT", orderId: 700 })]);
    expect(result.failures).toEqual([
      expect.objectContaining({ symbol: "ETHUSDT", direction: "SHORT", error: expect.stringContaining("-2019") }),
    ]);
    const orderRequests = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(orderRequests).toHaveLength(2);
  });

  it("sends a signed cancellation only to the futures testnet", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ symbol: "BTCUSDT", orderId: 123, status: "CANCELED", origQty: "0.001", executedQty: "0" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await binanceCancelTestnetOrder(
      testnetCreds,
      { symbol: "BTCUSDT", orderId: 123, confirmed: true },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toMatchObject({ orderId: 123, symbol: "BTCUSDT", status: "CANCELED" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://testnet.binancefuture.com/fapi/v1/order?");
    expect(String(url)).toContain("orderId=123");
    expect(String(url)).toMatch(/signature=[a-f0-9]{64}/);
    expect(init?.method).toBe("DELETE");
  });
});
