import { useEffect, useState } from "react";
import type {
  BinanceAccountBalance,
  BinanceAccountStatus,
  BinanceOpenOrderRow,
  BinanceOpenedPositionResult,
  BinancePositionRow,
} from "../../../../packages/core/src/contract/index.js";
import { errorMessage } from "../../api";
import { client } from "../../client";
import { priceStr } from "../../format";
import { Badge, Button, Card, Input, SectionTitle, Select } from "../../ui";

const usd = (n: number) => `$${n.toFixed(2)}`;

export function BinanceAccountCard() {
  const [status, setStatus] = useState<BinanceAccountStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [testnet, setTestnet] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<BinanceAccountBalance | null>(null);
  const [positions, setPositions] = useState<BinancePositionRow[] | null>(null);
  const [orders, setOrders] = useState<BinanceOpenOrderRow[] | null>(null);
  const [orderSymbol, setOrderSymbol] = useState("BTCUSDT");
  const [orderDirection, setOrderDirection] = useState<"LONG" | "SHORT">("LONG");
  const [initialMargin, setInitialMargin] = useState("20");
  const [leverage, setLeverage] = useState("5");
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderResult, setOrderResult] = useState<BinanceOpenedPositionResult | null>(null);
  const [cancelingOrderId, setCancelingOrderId] = useState<number | null>(null);
  const [closingPositionKey, setClosingPositionKey] = useState<string | null>(null);
  const [orderMessage, setOrderMessage] = useState<string | null>(null);

  const loadReadonly = async () => {
    try {
      const [b, p, o] = await Promise.all([
        client.binanceAccount.balance(),
        client.binanceAccount.positions(),
        client.binanceAccount.openOrders(),
      ]);
      setBalance(b);
      setPositions(p);
      setOrders(o);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    client.binanceAccount
      .status()
      .then((s) => {
        setStatus(s);
        setTestnet(s.testnet);
        if (s.configured && s.connected) void loadReadonly();
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await client.binanceAccount.connect({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), testnet });
      setStatus(s);
      setApiKey("");
      setApiSecret("");
      if (s.connected) await loadReadonly();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.binanceAccount.disconnect();
      setStatus({ configured: false, testnet, maskedKey: null, connected: false, lastError: null });
      setBalance(null);
      setPositions(null);
      setOrders(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const placeTestnetOrder = async () => {
    const symbol = orderSymbol.trim().toUpperCase();
    const margin = Number(initialMargin);
    const leverageValue = Number(leverage);
    const takeProfit = takeProfitPrice.trim() ? Number(takeProfitPrice) : undefined;
    const stopLoss = stopLossPrice.trim() ? Number(stopLossPrice) : undefined;
    if (!orderConfirmed) return;

    setOrderBusy(true);
    setError(null);
    setOrderResult(null);
    setOrderMessage(null);
    try {
      const result = await client.binanceAccount.placeTestnetOrder({
        symbol,
        direction: orderDirection,
        initialMargin: margin,
        leverage: leverageValue,
        takeProfitPrice: takeProfit,
        stopLossPrice: stopLoss,
        confirmed: true,
      });
      setOrderResult(result);
      setOrderConfirmed(false);
      await loadReadonly();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setOrderBusy(false);
    }
  };

  const closeTestnetPosition = async (position: BinancePositionRow) => {
    const direction = position.side === "long" ? "LONG" : "SHORT";
    if (!window.confirm(
      `确认按市价平掉整个测试网持仓？\n\n${position.symbol} ${direction === "LONG" ? "多仓" : "空仓"} ${Math.abs(position.positionAmt)}\n\n成交价格可能与当前标记价格不同。`,
    )) return;
    const key = `${position.symbol}:${position.side}`;
    setClosingPositionKey(key);
    setError(null);
    setOrderMessage(null);
    try {
      const result = await client.binanceAccount.closeTestnetPosition({
        symbol: position.symbol,
        direction,
        confirmed: true,
      });
      setOrderMessage(`已按市价平掉 ${position.symbol} ${direction === "LONG" ? "多仓" : "空仓"}，订单 #${result.orderId}，状态 ${result.status}`);
      await loadReadonly();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setClosingPositionKey(null);
    }
  };

  const cancelTestnetOrder = async (order: BinanceOpenOrderRow) => {
    if (!window.confirm(`确认撤销测试网订单？\n\n${order.symbol} ${order.side} ${order.type}\n订单号：${order.orderId}`)) return;
    setCancelingOrderId(order.orderId);
    setError(null);
    setOrderMessage(null);
    try {
      await client.binanceAccount.cancelTestnetOrder({ symbol: order.symbol, orderId: order.orderId, confirmed: true });
      setOrderMessage(`测试网订单 #${order.orderId} 已撤销`);
      await loadReadonly();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCancelingOrderId(null);
    }
  };

  const connected = status?.configured && status.connected;
  const marginValue = Number(initialMargin);
  const leverageValue = Number(leverage);
  const takeProfitValue = takeProfitPrice.trim() ? Number(takeProfitPrice) : null;
  const stopLossValue = stopLossPrice.trim() ? Number(stopLossPrice) : null;
  const estimatedPositionValue = marginValue * leverageValue;
  const orderReady =
    connected &&
    status.testnet &&
    /^[A-Z0-9]{2,20}USDT$/.test(orderSymbol.trim().toUpperCase()) &&
    Number.isFinite(marginValue) &&
    marginValue > 0 &&
    Number.isSafeInteger(leverageValue) &&
    leverageValue >= 1 &&
    leverageValue <= 125 &&
    (takeProfitValue === null || (Number.isFinite(takeProfitValue) && takeProfitValue > 0)) &&
    (stopLossValue === null || (Number.isFinite(stopLossValue) && stopLossValue > 0)) &&
    orderConfirmed;

  return (
    <Card className="settings-binance-card">
      <SectionTitle>Binance 账号</SectionTitle>

      {status?.configured ? (
        <>
          <div className="settings-cred-row">
            <span className="settings-cred-name">状态</span>
            <Badge tone={status.connected ? "up" : "down"}>{status.connected ? "已连接" : "连接失败"}</Badge>
            <Badge tone={status.testnet ? undefined : "down"}>{status.testnet ? "测试网" : "主网真账号"}</Badge>
            <span className="settings-cred-actions">
              <Button disabled={busy} onClick={disconnect}>
                断开
              </Button>
            </span>
          </div>
          {status.maskedKey && (
            <div className="settings-cred-row">
              <span className="settings-cred-name">API Key</span>
              <span className="settings-cred-meta">{status.maskedKey}</span>
            </div>
          )}
          {status.lastError && <div className="settings-test-result settings-test-result--fail">{status.lastError}</div>}
        </>
      ) : (
        <>
          <div className="settings-cred-row">
            <span className="settings-cred-name">API Key</span>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Binance API Key" autoComplete="off" />
          </div>
          <div className="settings-cred-row">
            <span className="settings-cred-name">API Secret</span>
            <Input
              type="password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder="Binance API Secret"
              autoComplete="off"
            />
          </div>
          <div className="settings-cred-row">
            <label className="settings-cred-name">
              <input type="checkbox" checked={testnet} onChange={(e) => setTestnet(e.target.checked)} /> 使用测试网
            </label>
            <span className="settings-cred-actions">
              <Button accent disabled={busy || !apiKey.trim() || !apiSecret.trim()} onClick={connect}>
                连接
              </Button>
            </span>
          </div>
        </>
      )}

      {error && <div className="settings-test-result settings-test-result--fail settings-binance-message">{error}</div>}

      {connected && balance && (
        <div className="settings-cred-row">
          <span className="settings-cred-name">余额</span>
          <span className="settings-cred-meta">
            钱包 {usd(balance.totalWalletBalance)} · 可用 {usd(balance.availableBalance)} · 浮盈亏 {usd(balance.totalUnrealizedPnl)}
          </span>
        </div>
      )}

      {connected && positions && positions.length > 0 && (
        <div className="settings-cred-block">
          <div className="settings-cred-name">持仓</div>
          {positions.map((p) => (
            <div key={`${p.symbol}:${p.side}`} className="settings-binance-position-row">
              <span className="settings-cred-meta">
                {p.symbol} {p.side === "long" ? "多" : "空"} {Math.abs(p.positionAmt)} @ {priceStr(p.entryPrice)} · 标记{" "}
                {priceStr(p.markPrice)} · 浮盈亏 {usd(p.unrealizedPnl)} · {p.leverage}x
              </span>
              {status.testnet && (
                <Button
                  disabled={closingPositionKey !== null}
                  onClick={() => closeTestnetPosition(p)}
                >
                  {closingPositionKey === `${p.symbol}:${p.side}` ? "平仓中…" : "市价平仓"}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {connected && orders && orders.length > 0 && (
        <div className="settings-cred-block">
          <div className="settings-cred-name">挂单</div>
          {orders.map((o) => (
            <div key={o.orderId} className="settings-binance-open-order">
              <span className="settings-cred-meta">
                {o.symbol} {o.side} {o.type} {o.origQty} @ {priceStr(o.price || o.stopPrice)} · {o.status}
              </span>
              {status.testnet && (
                <Button disabled={cancelingOrderId !== null} onClick={() => cancelTestnetOrder(o)}>
                  {cancelingOrderId === o.orderId ? "撤销中…" : "撤单"}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {connected && status.testnet && (
        <div className="settings-binance-order">
          <div className="settings-binance-order-head">
            <span>测试网手动下单</span>
            <Badge>不会触碰主网资金</Badge>
          </div>
          <div className="settings-binance-order-grid">
            <label>
              <span>交易对</span>
              <Input
                value={orderSymbol}
                onChange={(event) => setOrderSymbol(event.target.value.toUpperCase())}
                placeholder="BTCUSDT"
                autoComplete="off"
              />
            </label>
            <label>
              <span>方向</span>
              <Select
                value={orderDirection}
                options={[{ value: "LONG", label: "开多" }, { value: "SHORT", label: "开空" }]}
                onChange={(value) => setOrderDirection(value as "LONG" | "SHORT")}
              />
            </label>
            <label>
              <span>初始保证金（USDT）</span>
              <Input
                type="number"
                min="0"
                step="any"
                value={initialMargin}
                onChange={(event) => setInitialMargin(event.target.value)}
                placeholder="20"
              />
            </label>
            <label>
              <span>杠杆倍数</span>
              <Input
                type="number"
                min="1"
                max="125"
                step="1"
                value={leverage}
                onChange={(event) => setLeverage(event.target.value)}
                placeholder="5"
              />
            </label>
            <label>
              <span>止盈价格（可留空）</span>
              <Input
                type="number"
                min="0"
                step="any"
                value={takeProfitPrice}
                onChange={(event) => setTakeProfitPrice(event.target.value)}
                placeholder="止盈触发价"
              />
            </label>
            <label>
              <span>止损价格（可留空）</span>
              <Input
                type="number"
                min="0"
                step="any"
                value={stopLossPrice}
                onChange={(event) => setStopLossPrice(event.target.value)}
                placeholder="止损触发价"
              />
            </label>
            <label className="settings-binance-confirm">
              <input
                type="checkbox"
                checked={orderConfirmed}
                onChange={(event) => setOrderConfirmed(event.target.checked)}
              />
              <span>我已核对以上参数，确认提交测试网订单</span>
            </label>
          </div>
          {Number.isFinite(estimatedPositionValue) && estimatedPositionValue > 0 && (
            <div className="settings-binance-order-summary">
              预计仓位金额约 {estimatedPositionValue.toFixed(2)} USDT；将按当前标记价格换算数量，并以市价开{orderDirection === "LONG" ? "多" : "空"}。
            </div>
          )}
          <div className="settings-binance-order-actions">
            <Button accent disabled={!orderReady || orderBusy} onClick={placeTestnetOrder}>
              {orderBusy ? "提交中…" : `测试网开${orderDirection === "LONG" ? "多" : "空"}`}
            </Button>
          </div>
          {orderResult && (
            <div className={`settings-test-result ${orderResult.protectionErrors.length ? "settings-test-result--fail" : "settings-test-result--ok"}`}>
              测试网已开{orderResult.direction === "LONG" ? "多" : "空"}：{orderResult.entryOrder.symbol}，
              {orderResult.leverage}x，数量 {orderResult.quantity}，开仓订单 #{orderResult.entryOrder.orderId}，状态 {orderResult.entryOrder.status}。
              {orderResult.takeProfitOrder ? ` 止盈单 #${orderResult.takeProfitOrder.algoId}。` : ""}
              {orderResult.stopLossOrder ? ` 止损单 #${orderResult.stopLossOrder.algoId}。` : ""}
              {orderResult.protectionErrors.length ? ` ${orderResult.protectionErrors.join("；")}` : ""}
            </div>
          )}
          {orderMessage && <div className="settings-test-result settings-test-result--ok">{orderMessage}</div>}
        </div>
      )}

      {connected && !status.testnet && (
        <div className="settings-warning-strip settings-binance-mainnet-warning">
          当前连接的是主网真账号。项目继续禁止主网下单；如需测试手动下单，请断开后改连测试网。
        </div>
      )}

      <div className="settings-footer-note">
        账号连接用于展示余额、持仓与挂单；连接测试网时还可在人工核对后设置初始保证金、杠杆、方向、止盈和止损，并按市价开仓。主网下单仍由服务端硬性禁止，
        AI 也不会自动触发订单。密钥用本机加密存储；测试网 key 需要交易权限，主网 key 仍建议只授予读取权限并设置 IP 白名单。
      </div>
    </Card>
  );
}
