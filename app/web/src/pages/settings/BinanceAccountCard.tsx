import { useEffect, useState } from "react";
import type {
  BinanceAccountBalance,
  BinanceAccountStatus,
  BinanceOpenOrderRow,
  BinancePositionRow,
} from "../../../../packages/core/src/contract/index.js";
import { errorMessage } from "../../api";
import { client } from "../../client";
import { priceStr } from "../../format";
import { Badge, Button, Card, Input, SectionTitle } from "../../ui";

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

  const connected = status?.configured && status.connected;

  return (
    <Card className="settings-binance-card">
      <SectionTitle>Binance 账号（只读）</SectionTitle>

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
          {error && <div className="settings-test-result settings-test-result--fail">{error}</div>}
        </>
      )}

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
            <div key={p.symbol} className="settings-cred-meta">
              {p.symbol} {p.side === "long" ? "多" : "空"} {Math.abs(p.positionAmt)} @ {priceStr(p.entryPrice)} · 标记{" "}
              {priceStr(p.markPrice)} · 浮盈亏 {usd(p.unrealizedPnl)} · {p.leverage}x
            </div>
          ))}
        </div>
      )}

      {connected && orders && orders.length > 0 && (
        <div className="settings-cred-block">
          <div className="settings-cred-name">挂单</div>
          {orders.map((o) => (
            <div key={o.orderId} className="settings-cred-meta">
              {o.symbol} {o.side} {o.type} {o.origQty} @ {priceStr(o.price || o.stopPrice)} · {o.status}
            </div>
          ))}
        </div>
      )}

      <div className="settings-footer-note">
        只读连接：仅用于展示余额、持仓与挂单，<b>不会下任何单</b>。建议先用 Binance 期货测试网 API key
        验证；密钥用本机加密存储，请只授予读取权限、并设置 IP 白名单。实盘自动下单是后续单独功能。
      </div>
    </Card>
  );
}
