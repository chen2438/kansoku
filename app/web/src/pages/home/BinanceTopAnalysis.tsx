import { Activity, Clock3, LoaderCircle, ShieldAlert, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BinanceBatchItem, BinanceBatchRanking, BinanceBatchState } from "../../../../packages/core/src/contract/symbols";
import { errorMessage } from "../../api";
import { client } from "../../client";
import { openSymbolContextMenu } from "../../desktop/newTab";
import { Button, ErrorBox } from "../../ui";

const POLL_MS = 2_000;
const RANKING_LABEL: Record<BinanceBatchRanking, string> = {
  volume_top20: "成交额 Top 20",
  gainers_top10: "涨幅 Top 10",
  losers_top10: "跌幅 Top 10",
};

const DIR_LABEL: Record<string, string> = { long: "做多", short: "做空", neutral: "观望" };
const ENTRY_STATUS_LABEL: Record<string, string> = {
  waiting: "待触发",
  triggered: "已触发",
  invalidated: "已失效",
  stopped: "已止损",
};

function itemLabel(item: BinanceBatchItem): string {
  if (item.status === "skipped") return "已有仓位 · 跳过分析";
  if (item.status === "queued") return "等待";
  if (item.status === "running") return "分析中";
  if (item.status === "failed") return "失败";
  // completed —— 显示分析结论而非"完成"
  if (!item.direction) return "完成";
  if (item.direction === "neutral") return item.tradeStatus === "skipped" ? "观望 · 未下单" : "观望";
  const dir = DIR_LABEL[item.direction] ?? item.direction;
  const status = item.entryStatus ? ENTRY_STATUS_LABEL[item.entryStatus] : null;
  if (item.tradeStatus === "pending") return `${dir} · 等待下单`;
  if (item.tradeStatus === "submitted") return `${dir} · 已下单 #${item.tradeOrderId ?? "—"}`;
  if (item.tradeStatus === "skipped") return `${dir} · 已有仓位或挂单，已跳过`;
  if (item.tradeStatus === "failed") return `${dir} · 下单失败${item.tradeOrderId ? ` #${item.tradeOrderId}` : ""}`;
  return status ? `${dir}（${status}）` : dir;
}

export function BinanceTopAnalysis() {
  const [batch, setBatch] = useState<BinanceBatchState | null>(null);
  const [starting, setStarting] = useState(false);
  const [continuous, setContinuous] = useState(true);
  const [automationRanking, setAutomationRanking] = useState<BinanceBatchRanking>("volume_top20");
  const [automationEndAt, setAutomationEndAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBatch(await client.symbols.binanceTopAnalysisStatus());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (batch?.status !== "running" && !batch?.automation?.active) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [batch?.status, batch?.automation?.active, refresh]);

  const start = async (
    autoTrade = false,
    repeatHourly = false,
    ranking: BinanceBatchRanking = "volume_top20",
  ) => {
    if (repeatHourly && !continuous && !automationEndAt) {
      setError("请设置自动任务结束时间，或勾选持续运行");
      return;
    }
    if (autoTrade && !window.confirm(
      repeatHourly
        ? `确认启动每小时自动分析并下单？\n\n榜单：${RANKING_LABEL[ranking]}。任务会立即运行一轮，之后每小时重新读取该榜单。已有仓位的标的会在分析前跳过；其余做多或做空结论按 20 USDT 初始保证金、20 倍杠杆市价开仓。${continuous ? "任务将持续运行，直到人工停止。" : `任务运行到 ${new Date(automationEndAt).toLocaleString("zh-CN")}。`}\n\n任务在本机服务端运行，只允许 Binance 期货测试网。`
        : `确认启动测试网 AI 分析并下单？\n\n榜单：${RANKING_LABEL[ranking]}。已有仓位的标的会在分析前跳过；其余做多或做空结论立即按 20 USDT 初始保证金、20 倍杠杆市价开仓，目标1止盈、AI 止损价止损。观望不下单。\n\n这只允许连接 Binance 期货测试网后执行。`,
    )) return;
    setStarting(true);
    setError(null);
    try {
      setBatch(await client.symbols.binanceTopAnalysisStart(autoTrade ? {
        autoTrade: true,
        confirmed: true,
        ranking,
        ...(repeatHourly ? {
          repeatHourly: true,
          automationEndAt: continuous ? null : new Date(automationEndAt).toISOString(),
        } : {}),
      } : { ranking }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStarting(false);
    }
  };

  const stopAutomation = async () => {
    setStarting(true);
    setError(null);
    try {
      setBatch(await client.symbols.binanceTopAnalysisAutomationStop());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStarting(false);
    }
  };

  const counts = useMemo(() => {
    const items = batch?.items ?? [];
    return {
      done: items.filter((item) => item.status === "completed" || item.status === "skipped").length,
      failed: items.filter((item) => item.status === "failed").length,
      traded: items.filter((item) => item.tradeStatus === "submitted").length,
      tradeFailed: items.filter((item) => item.tradeStatus === "failed").length,
      neutralSkipped: items.filter((item) => item.tradeStatus === "skipped" && item.direction === "neutral").length,
      exposureSkipped: items.filter((item) => item.status === "skipped" || (item.tradeStatus === "skipped" && item.direction !== "neutral")).length,
      total: items.length,
    };
  }, [batch]);
  const running = batch?.status === "running";
  const automationActive = batch?.automation?.active === true;
  const tradeFailureLogs = useMemo(
    () => (batch?.items ?? []).filter((item) => item.tradeStatus === "failed" && item.tradeError),
    [batch],
  );

  return (
    <section className="binance-batch" aria-label="Binance 成交额 Top 20 AI 分析">
      <div className="binance-batch-head">
        <div className="binance-batch-actions">
          <Button accent onClick={() => void start(false)} disabled={starting || running || automationActive} state={running ? "busy" : undefined}>
            {running ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}
            {running ? "批量分析中" : "AI 分析 Binance Top 20"}
          </Button>
          <Button
            className="binance-batch-trade-btn"
            onClick={() => void start(true)}
            disabled={starting || running || automationActive}
          >
            <ShieldAlert size={14} />
            AI 分析 Binance Top 20 并下单
          </Button>
          <Button
            className="binance-batch-gainers-btn"
            onClick={() => void start(true, false, "gainers_top10")}
            disabled={starting || running || automationActive}
          >
            <ShieldAlert size={14} />
            AI 分析 Binance 涨幅 Top 10 并下单
          </Button>
          <Button
            className="binance-batch-losers-btn"
            onClick={() => void start(true, false, "losers_top10")}
            disabled={starting || running || automationActive}
          >
            <ShieldAlert size={14} />
            AI 分析 Binance 跌幅 Top 10 并下单
          </Button>
          <div className="binance-batch-automation-controls">
            <label>
              自动榜单
              <select
                value={automationRanking}
                onChange={(event) => setAutomationRanking(event.target.value as BinanceBatchRanking)}
                disabled={automationActive}
              >
                <option value="volume_top20">成交额 Top 20</option>
                <option value="gainers_top10">涨幅 Top 10</option>
                <option value="losers_top10">跌幅 Top 10</option>
              </select>
            </label>
            <label>
              <input type="checkbox" checked={continuous} onChange={(event) => setContinuous(event.target.checked)} disabled={automationActive} />
              持续运行
            </label>
            {!continuous && (
              <label>
                运行到
                <input
                  type="datetime-local"
                  value={automationEndAt}
                  min={new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)}
                  onChange={(event) => setAutomationEndAt(event.target.value)}
                  disabled={automationActive}
                />
              </label>
            )}
            {automationActive ? (
              <Button onClick={() => void stopAutomation()} disabled={starting}>
                <Square size={13} />停止自动任务
              </Button>
            ) : (
              <Button onClick={() => void start(true, true, automationRanking)} disabled={starting || running}>
                <Clock3 size={14} />每小时自动分析并下单
              </Button>
            )}
          </div>
        </div>
        {batch && (
          <span className="binance-batch-summary">
            {RANKING_LABEL[batch.ranking]} · {counts.done}/{counts.total} 完成{counts.failed > 0 ? ` · ${counts.failed} 分析失败` : ""}
            {batch.mode === "analysis_and_trade" ? ` · ${counts.traded} 已下单 · ${counts.neutralSkipped} 观望 · ${counts.exposureSkipped} 已有仓位/挂单跳过 · ${counts.tradeFailed} 下单失败` : ""}
            {batch.automation ? (
              <span className="binance-batch-automation-summary">
                {batch.automation.active ? ` · 自动任务运行中（第 ${batch.automation.runCount} 轮）${batch.automation.nextRunAt ? ` · 下次 ${new Date(batch.automation.nextRunAt).toLocaleString("zh-CN")}` : ""}` : ` · 自动任务已停止（共 ${batch.automation.runCount} 轮）`}
                {batch.automation.endAt ? ` · 运行到 ${new Date(batch.automation.endAt).toLocaleString("zh-CN")}` : ""}
                {batch.automation.lastError ? ` · 上轮启动失败：${batch.automation.lastError}` : ""}
              </span>
            ) : null}
          </span>
        )}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {batch && (
        <div className="binance-batch-items">
          {batch.items.map((item) => (
            <a key={item.symbol} className={`binance-batch-item is-${item.status}${item.tradeStatus ? ` trade-${item.tradeStatus}` : ""}`} href={`/symbol/${encodeURIComponent(item.symbol)}`} onContextMenu={(e) => openSymbolContextMenu(item.symbol, e)} title={item.skipReason ?? item.tradeError ?? item.error ?? `24h 成交额 ${item.quoteVolume.toLocaleString("zh-CN")} USDT`}>
              <span>{item.rank}. {item.symbol}</span>
              <span>{itemLabel(item)}</span>
            </a>
          ))}
        </div>
      )}
      {tradeFailureLogs.length > 0 && (
        <div className="binance-batch-failure-log" role="log" aria-label="Binance 下单失败日志">
          <div className="binance-batch-failure-title">下单失败日志（{tradeFailureLogs.length}）</div>
          {tradeFailureLogs.map((item) => (
            <div key={item.symbol} className="binance-batch-failure-row">
              <span>{item.rank}. {item.symbol}{item.tradeOrderId ? ` · 开仓订单 #${item.tradeOrderId}` : ""}</span>
              <span>{item.tradeError}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
