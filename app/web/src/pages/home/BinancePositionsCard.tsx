import { useMemo, useState } from "react";
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

function closedAtText(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
}

function closedDirectionLabel(direction: ClosedTrade["direction"]): string {
  if (direction === "long") return "做多";
  if (direction === "short") return "做空";
  if (direction === "mixed") return "多空混合";
  return "方向未知";
}

function tradeSourceLabel(source: ClosedTrade["source"]): string {
  if (source === "volume_top20") return "成交额榜";
  if (source === "gainers_top10") return "涨幅榜";
  if (source === "losers_top10") return "跌幅榜";
  if (source === "manual") return "手动";
  if (source === "mixed") return "混合来源";
  return "来源未知";
}

type ClosedTrade = BinanceClosedPositionHistory["rows"][number];

interface ClosedContractGroup {
  key: string;
  symbol: string;
  asset: string;
  realizedPnl: number;
  feeAdjustments: number;
  netPnl: number;
  latestClosedAt: number;
  closeCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  rows: ClosedTrade[];
}

function normalizeMoney(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export function groupClosedTrades(rows: ClosedTrade[]): ClosedContractGroup[] {
  const groups = new Map<string, ClosedContractGroup>();
  for (const row of rows) {
    const key = `${row.symbol}:${row.asset}`;
    const group = groups.get(key) ?? {
      key,
      symbol: row.symbol,
      asset: row.asset,
      realizedPnl: 0,
      feeAdjustments: 0,
      netPnl: 0,
      latestClosedAt: row.closedAt,
      closeCount: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      rows: [],
    };
    group.realizedPnl = normalizeMoney(group.realizedPnl + row.realizedPnl);
    group.feeAdjustments = normalizeMoney(group.feeAdjustments + row.commission + row.fundingFee + row.otherAdjustments);
    group.netPnl = normalizeMoney(group.netPnl + row.netPnl);
    group.latestClosedAt = Math.max(group.latestClosedAt, row.closedAt);
    group.closeCount += row.closeCount;
    if (row.netPnl > 0) group.wins += 1;
    else if (row.netPnl < 0) group.losses += 1;
    group.winRate = group.wins + group.losses > 0 ? group.wins / (group.wins + group.losses) : null;
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.latestClosedAt - a.latestClosedAt || a.symbol.localeCompare(b.symbol));
}

export function BinancePositionsCard() {
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [expandedHistoryKey, setExpandedHistoryKey] = useState<string | null>(null);
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
  const historyGroups = useMemo(() => groupClosedTrades(history?.rows ?? []), [history]);
  const historyTotalNetPnl = useMemo(
    () => normalizeMoney(historyGroups.reduce((sum, group) => sum + group.netPnl, 0)),
    [historyGroups],
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
  const totalUnrealizedPnl = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const allNetPnlIncludesCosts = positions.every((position) => position.netUnrealizedPnlIncludesCosts);
  const totalIncurredCosts = allNetPnlIncludesCosts
    ? normalizeMoney(totalNetUnrealizedPnl - totalUnrealizedPnl)
    : null;

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
          未实现盈亏 <b className={upDown(totalUnrealizedPnl)}>{signedMoney(totalUnrealizedPnl)}</b>
        </span>
        <span>
          手续费/资金费{" "}
          {totalIncurredCosts === null ? (
            <b title="部分持仓缺少 Binance 盈亏平衡价，无法可靠反推已计费用">—</b>
          ) : (
            <b className={upDown(totalIncurredCosts)} title="按 Binance 盈亏平衡价与开仓价反推，包含已计入当前持仓的交易手续费和资金费">
              {signedMoney(totalIncurredCosts)}
            </b>
          )}
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
            <span>来源</span>
            <span>未实现盈亏</span>
            <span>手续费/资金费</span>
            <span>净浮盈亏</span>
            <span>操作</span>
          </div>
          {positions.map((position) => {
            const incurredCosts = position.netUnrealizedPnlIncludesCosts
              ? normalizeMoney(position.netUnrealizedPnl - position.unrealizedPnl)
              : null;
            return (
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
              <span className="binance-trade-source">{tradeSourceLabel(position.source)}</span>
              <span className={`pct ${upDown(position.unrealizedPnl)}`}>{signedMoney(position.unrealizedPnl)}</span>
              <span
                className={`pct ${incurredCosts === null ? "" : upDown(incurredCosts)}`}
                title={incurredCosts === null
                  ? "Binance 未返回有效盈亏平衡价，无法可靠反推手续费和资金费"
                  : "按盈亏平衡价与开仓价反推，包含已计入当前持仓的交易手续费和资金费"}
              >
                {incurredCosts === null ? "—" : signedMoney(incurredCosts)}
              </span>
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
            );
          })}
        </div>
      )}
      {actionMessage && <div className="binance-action-message">{actionMessage}</div>}
      {actionError && <div className="binance-action-error">{actionError}</div>}
      <div className="binance-history">
        <div className="binance-history-title">
          <span>近 90 天历史平仓（按合约汇总）</span>
          {history && history.rows.length > 0 && (
            <span className={upDown(historyTotalNetPnl)}>合计 {signedMoney(historyTotalNetPnl)} USDT</span>
          )}
        </div>
        {historyError ? (
          <div className="binance-history-error">历史记录拉取失败：{historyError}</div>
        ) : !history ? (
          <div className="binance-positions-empty">历史记录加载中…</div>
        ) : history.rows.length === 0 ? (
          <div className="binance-positions-empty">近 90 天暂无已平仓记录</div>
        ) : (
          <div className="binance-history-groups">
            <div className="binance-history-group-columns" aria-hidden="true">
              <span>合约</span>
              <span>记录 / 毛盈亏 / 费用</span>
              <span>最近平仓（本地）</span>
              <span>胜率</span>
              <span>累计净盈亏</span>
            </div>
            {historyGroups.map((group) => {
              const expanded = expandedHistoryKey === group.key;
              return (
                <div key={group.key} className={`binance-history-group${expanded ? " is-expanded" : ""}`}>
                  <button
                    type="button"
                    className="binance-history-group-row"
                    aria-expanded={expanded}
                    onClick={() => setExpandedHistoryKey(expanded ? null : group.key)}
                  >
                    <span className="sym"><span aria-hidden="true">{expanded ? "▾" : "▸"}</span> {group.symbol}</span>
                    <span className="detail">
                      {group.rows.length} 组 · {group.closeCount} 笔 · 毛盈亏 {signedMoney(group.realizedPnl)} · 费用 {signedMoney(group.feeAdjustments)}
                    </span>
                    <span className="date">{closedAtText(group.latestClosedAt)}</span>
                    <span className="win-rate" title={`盈利 ${group.wins} 组，亏损 ${group.losses} 组；净盈亏为 0 的组不计入胜负`}>
                      {group.winRate === null ? "—" : `${(group.winRate * 100).toFixed(1)}%`}
                    </span>
                    <span className={`net ${upDown(group.netPnl)}`}>{signedMoney(group.netPnl)} {group.asset}</span>
                  </button>
                  {expanded && (
                    <div className="binance-history-group-details">
                      <div className="binance-history-list">
                        <div className="binance-history-columns" aria-hidden="true">
                          <span>合约</span>
                          <span>毛盈亏 / 费用</span>
                          <span>平仓时间（本地）</span>
                          <span>净盈亏</span>
                        </div>
                        {group.rows.map((row) => {
                          const feeAdjustments = row.commission + row.fundingFee + row.otherAdjustments;
                          return (
                            <div key={row.id} className="binance-history-row">
                              <a className="sym" href={`/symbol/${encodeURIComponent(row.symbol)}`}>{row.symbol}</a>
                              <span className="detail">
                                <span className={`binance-history-direction is-${row.direction}`}>{closedDirectionLabel(row.direction)}</span>
                                {" · "}<span className="binance-trade-source">{tradeSourceLabel(row.source)}</span>
                                {" · "}{row.closeCount > 1 && `${row.closeCount} 笔合并 · `}毛盈亏 {signedMoney(row.realizedPnl)} · 费用 {signedMoney(feeAdjustments)}
                              </span>
                              <span className="date">{closedAtText(row.closedAt)}</span>
                              <span className={`net ${upDown(row.netPnl)}`}>{signedMoney(row.netPnl)} {row.asset}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="binance-history-note">
          汇总行把同一合约近 90 天的净盈亏相加；点击合约可展开细目。细目中，同一合约相邻平仓时间不超过 60 秒时仍合并为一组，时间取该组最后一次平仓，最新记录在最上方。净盈亏计入交易手续费、资金费、清算调整和手续费返还，不计转账、赠金及邀请返佣。
        </div>
      </div>
    </Card>
  );
}
