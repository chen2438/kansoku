import { Activity, LoaderCircle, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BinanceBatchItem, BinanceBatchState } from "../../../../packages/core/src/contract/symbols";
import { errorMessage } from "../../api";
import { client } from "../../client";
import { openSymbolContextMenu } from "../../desktop/newTab";
import { Button, ErrorBox } from "../../ui";

const POLL_MS = 2_000;

const DIR_LABEL: Record<string, string> = { long: "做多", short: "做空", neutral: "观望" };
const ENTRY_STATUS_LABEL: Record<string, string> = {
  waiting: "待触发",
  triggered: "已触发",
  invalidated: "已失效",
  stopped: "已止损",
};

function itemLabel(item: BinanceBatchItem): string {
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
    if (batch?.status !== "running") return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [batch?.status, refresh]);

  const start = async (autoTrade = false) => {
    if (autoTrade && !window.confirm(
      "确认启动测试网 AI 分析并下单？\n\n最多分析 20 个标的。每个做多或做空结论都会立即按 20 USDT 初始保证金、10 倍杠杆市价开仓，目标1止盈、AI 止损价止损。观望不下单。\n\n这只允许连接 Binance 期货测试网后执行。",
    )) return;
    setStarting(true);
    setError(null);
    try {
      setBatch(await client.symbols.binanceTopAnalysisStart(autoTrade ? { autoTrade: true, confirmed: true } : {}));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStarting(false);
    }
  };

  const counts = useMemo(() => {
    const items = batch?.items ?? [];
    return {
      done: items.filter((item) => item.status === "completed").length,
      failed: items.filter((item) => item.status === "failed").length,
      traded: items.filter((item) => item.tradeStatus === "submitted").length,
      tradeFailed: items.filter((item) => item.tradeStatus === "failed").length,
      neutralSkipped: items.filter((item) => item.tradeStatus === "skipped" && item.direction === "neutral").length,
      exposureSkipped: items.filter((item) => item.tradeStatus === "skipped" && item.direction !== "neutral").length,
      total: items.length,
    };
  }, [batch]);
  const running = batch?.status === "running";
  const tradeFailureLogs = useMemo(
    () => (batch?.items ?? []).filter((item) => item.tradeStatus === "failed" && item.tradeError),
    [batch],
  );

  return (
    <section className="binance-batch" aria-label="Binance 成交额 Top 20 AI 分析">
      <div className="binance-batch-head">
        <div className="binance-batch-actions">
          <Button accent onClick={() => void start(false)} disabled={starting || running} state={running ? "busy" : undefined}>
            {running ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}
            {running ? "批量分析中" : "AI 分析 Binance Top 20"}
          </Button>
          <Button
            className="binance-batch-trade-btn"
            onClick={() => void start(true)}
            disabled={starting || running}
          >
            <ShieldAlert size={14} />
            AI 分析 Binance Top 20 并下单
          </Button>
        </div>
        {batch && (
          <span className="binance-batch-summary">
            {counts.done}/{counts.total} 完成{counts.failed > 0 ? ` · ${counts.failed} 分析失败` : ""}
            {batch.mode === "analysis_and_trade" ? ` · ${counts.traded} 已下单 · ${counts.neutralSkipped} 观望 · ${counts.exposureSkipped} 已有仓位/挂单跳过 · ${counts.tradeFailed} 下单失败` : ""}
          </span>
        )}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {batch && (
        <div className="binance-batch-items">
          {batch.items.map((item) => (
            <a key={item.symbol} className={`binance-batch-item is-${item.status}${item.tradeStatus ? ` trade-${item.tradeStatus}` : ""}`} href={`/symbol/${encodeURIComponent(item.symbol)}`} onContextMenu={(e) => openSymbolContextMenu(item.symbol, e)} title={item.tradeError ?? item.error ?? `24h 成交额 ${item.quoteVolume.toLocaleString("zh-CN")} USDT`}>
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
