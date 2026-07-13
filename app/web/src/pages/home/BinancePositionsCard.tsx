import { useState } from "react";
import type {
  BinanceAccountStatus,
  BinanceClosedPositionHistory,
  BinancePositionRow,
} from "../../../../packages/core/src/contract/index.js";
import { errorMessage } from "../../api";
import { client } from "../../client";
import { priceDecimals, priceStr, upDown } from "../../format";
import { Button, Card, ErrorBox } from "../../ui";
import { useIntervalFetch } from "../cockpit/useIntervalFetch";

function signedMoney(value: number): string {
  const sign = value < 0 ? "−" : "+";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function positionPrice(value: number, markPrice: number): string {
  return priceStr(value, priceDecimals(markPrice, true));
}

function shortDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(timestamp);
}

export function BinancePositionsCard() {
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: status, error: statusError, reload: reloadStatus } = useIntervalFetch<BinanceAccountStatus>(
    "binanceAccount.status:home",
    () => client.binanceAccount.status(),
    60_000,
  );
  const connected = Boolean(status?.configured && status.connected);
  const { data: positions, error: positionsError, reload: reloadPositions } = useIntervalFetch<BinancePositionRow[]>(
    connected ? "binanceAccount.positions:home" : null,
    () => client.binanceAccount.positions(),
    60_000,
  );
  const { data: history, error: historyError, reload: reloadHistory } = useIntervalFetch<BinanceClosedPositionHistory>(
    connected ? "binanceAccount.closedPositionHistory:home" : null,
    () => client.binanceAccount.closedPositionHistory(),
    60_000,
  );

  const refresh = () => {
    reloadStatus();
    if (connected) {
      reloadPositions();
      reloadHistory();
    }
  };

  const closePosition = async (position: BinancePositionRow) => {
    if (!status?.testnet) return;
    const direction = position.side === "long" ? "LONG" : "SHORT";
    if (!window.confirm(
      `确认按市价平掉整个测试网持仓？\n\n${position.symbol} ${direction === "LONG" ? "多仓" : "空仓"} ${Math.abs(position.positionAmt)}\n\n成交价格可能与当前标记价格不同。`,
    )) return;

    const key = `${position.symbol}:${position.side}`;
    setClosingKey(key);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await client.binanceAccount.closeTestnetPosition({
        symbol: position.symbol,
        direction,
        confirmed: true,
      });
      setActionMessage(`已市价平掉 ${position.symbol} ${direction === "LONG" ? "多仓" : "空仓"}，订单 #${result.orderId}，状态 ${result.status}`);
      reloadPositions();
      reloadHistory();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setClosingKey(null);
    }
  };

  const closeAllPositions = async () => {
    if (!status?.testnet || !positions?.length) return;
    if (!window.confirm(
      `确认按市价平掉测试网全部 ${positions.length} 个持仓？\n\n${positions.map((position) => `${position.symbol} ${position.side === "long" ? "多仓" : "空仓"}`).join("、")}\n\n程序会逐个提交；某个失败时仍会继续处理其他持仓。`,
    )) return;

    setClosingAll(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await client.binanceAccount.closeAllTestnetPositions({ confirmed: true });
      setActionMessage(`全部平仓处理完成：成功 ${result.closed.length} 个，失败 ${result.failures.length} 个。`);
      setActionError(result.failures.length
        ? result.failures.map((failure) => `${failure.symbol}：${failure.error}`).join("；")
        : null);
      reloadPositions();
      reloadHistory();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setClosingAll(false);
    }
  };

  if (statusError) return <ErrorBox>Binance 账号状态拉取失败：{statusError}</ErrorBox>;
  if (!status) return <div className="note-block">Binance 持仓加载中…</div>;
  if (!status.configured) {
    return (
      <Card className="positions-card binance-positions-card">
        <div className="binance-positions-empty">
          尚未连接 Binance 账号，
          <a className="binance-positions-settings-link" href="/settings">
            前往设置
          </a>
        </div>
      </Card>
    );
  }
  if (!status.connected) {
    return (
      <ErrorBox>
        Binance 账号连接失败：{status.lastError ?? "请检查账号设置"} ·{" "}
        <a className="binance-positions-settings-link" href="/settings">前往设置</a>
      </ErrorBox>
    );
  }
  if (positionsError) return <ErrorBox>Binance 持仓拉取失败：{positionsError}</ErrorBox>;
  if (!positions) return <div className="note-block">Binance 持仓加载中…</div>;

  const totalNetUnrealizedPnl = positions.reduce((sum, position) => sum + position.netUnrealizedPnl, 0);
  const allNetPnlIncludesCosts = positions.every((position) => position.netUnrealizedPnlIncludesCosts);

  return (
    <Card className="positions-card binance-positions-card">
      <div className="positions-summary">
        <span>
          账户 <b>{status.testnet ? "测试网" : "主网"}</b>
        </span>
        <span>
          仓位 <b>{positions.length}</b>
        </span>
        <span>
          净浮盈亏{" "}
          <b className={upDown(totalNetUnrealizedPnl)} title={allNetPnlIncludesCosts ? "按 Binance 盈亏平衡价计算，已反映当前已发生的持仓成本" : "部分持仓缺少盈亏平衡价，暂时使用 Binance 毛浮盈亏"}>
            {signedMoney(totalNetUnrealizedPnl)}
          </b>
        </span>
        <span className="binance-positions-actions">
          <Button className="binance-compact-btn" onClick={refresh}>刷新</Button>
          {status.testnet && positions.length > 0 && (
            <Button
              className="binance-compact-btn binance-close-all-btn"
              disabled={closingAll || closingKey !== null}
              onClick={closeAllPositions}
            >
              {closingAll ? "全部平仓中…" : "全部市价平仓"}
            </Button>
          )}
        </span>
      </div>
      {positions.length === 0 ? (
        <div className="binance-positions-empty">暂无 Binance 持仓</div>
      ) : (
        <div className="positions-list binance-positions-list">
          <div className="binance-positions-columns" aria-hidden="true">
            <span>合约</span>
            <span>方向 / 数量 @ 开仓价 · 杠杆</span>
            <span>标记价</span>
            <span>净浮盈亏</span>
            <span>操作</span>
          </div>
          {positions.map((position) => (
            <div key={`${position.symbol}:${position.side}`} className="positions-row">
              <a className="sym" href={`/symbol/${encodeURIComponent(position.symbol)}`}>
                {position.symbol}
              </a>
              <span className="detail">
                <span className={position.side === "long" ? "up" : "down"}>
                  {position.side === "long" ? "多" : "空"}
                </span>{" "}
                {Math.abs(position.positionAmt)} @ {positionPrice(position.entryPrice, position.markPrice)} · {position.leverage}x
              </span>
              <span className="last">{positionPrice(position.markPrice, position.markPrice)}</span>
              <span
                className={`pct ${upDown(position.netUnrealizedPnl)}`}
                title={position.netUnrealizedPnlIncludesCosts
                  ? `毛浮盈亏 ${signedMoney(position.unrealizedPnl)}；净浮盈亏按盈亏平衡价 ${positionPrice(position.breakEvenPrice, position.markPrice)} 计算`
                  : "Binance 未返回有效盈亏平衡价，暂时显示毛浮盈亏"}
              >
                {signedMoney(position.netUnrealizedPnl)}
              </span>
              <span className="binance-position-action">
                {status.testnet && (
                  <Button
                    className="binance-compact-btn"
                    disabled={closingAll || closingKey !== null}
                    onClick={() => closePosition(position)}
                  >
                    {closingKey === `${position.symbol}:${position.side}` ? "平仓中…" : "市价平仓"}
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {actionMessage && <div className="binance-action-message">{actionMessage}</div>}
      {actionError && <div className="binance-action-error">{actionError}</div>}
      <div className="binance-history">
        <div className="binance-history-title">近 90 天已平仓合约净盈亏</div>
        {historyError ? (
          <div className="binance-history-error">历史记录拉取失败：{historyError}</div>
        ) : !history ? (
          <div className="binance-positions-empty">历史记录加载中…</div>
        ) : history.rows.length === 0 ? (
          <div className="binance-positions-empty">近 90 天暂无已平仓记录</div>
        ) : (
          <div className="binance-history-list">
            <div className="binance-history-columns" aria-hidden="true">
              <span>合约</span>
              <span>毛盈亏 / 费用</span>
              <span>最后平仓</span>
              <span>净盈亏</span>
            </div>
            {history.rows.map((row) => {
              const feeAdjustments = row.commission + row.fundingFee + row.otherAdjustments;
              return (
                <div key={`${row.symbol}:${row.asset}`} className="binance-history-row">
                  <a className="sym" href={`/symbol/${encodeURIComponent(row.symbol)}`}>
                    {row.symbol}
                  </a>
                  <span className="detail">
                    毛盈亏 {signedMoney(row.realizedPnl)} · 费用 {signedMoney(feeAdjustments)}
                  </span>
                  <span className="date">{shortDate(row.lastClosedAt)}</span>
                  <span className={`net ${upDown(row.netPnl)}`}>
                    {signedMoney(row.netPnl)} {row.asset}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="binance-history-note">
          净盈亏已计入交易手续费、资金费、清算调整和手续费返还；不计转账、赠金及邀请返佣。Binance 只提供近三个月资金流水。
        </div>
      </div>
    </Card>
  );
}
