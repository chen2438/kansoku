import { Activity, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BinanceBatchState } from "../../../../packages/core/src/contract/symbols";
import { errorMessage } from "../../api";
import { client } from "../../client";
import { Button, ErrorBox } from "../../ui";

const POLL_MS = 2_000;

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

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setBatch(await client.symbols.binanceTopAnalysisStart());
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
      total: items.length,
    };
  }, [batch]);
  const running = batch?.status === "running";

  return (
    <section className="binance-batch" aria-label="Binance 成交额 Top 20 AI 分析">
      <div className="binance-batch-head">
        <Button accent onClick={() => void start()} disabled={starting || running} state={running ? "busy" : undefined}>
          {running ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}
          {running ? "批量分析中" : "AI 分析 Binance Top 20"}
        </Button>
        {batch && <span className="binance-batch-summary">{counts.done}/{counts.total} 完成{counts.failed > 0 ? ` · ${counts.failed} 失败` : ""}</span>}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {batch && (
        <div className="binance-batch-items">
          {batch.items.map((item) => (
            <a key={item.symbol} className={`binance-batch-item is-${item.status}`} href={`/symbol/${encodeURIComponent(item.symbol)}`} title={item.error ?? `24h 成交额 ${item.quoteVolume.toLocaleString("zh-CN")} USDT`}>
              <span>{item.rank}. {item.symbol}</span>
              <span>{item.status === "queued" ? "等待" : item.status === "running" ? "分析中" : item.status === "completed" ? "完成" : "失败"}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
