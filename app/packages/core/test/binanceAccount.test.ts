import { describe, expect, it, vi } from "vitest";
import {
  binanceCancelTestnetOrder,
  binanceCloseTestnetPosition,
  binancePlaceTestnetOrder,
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
