import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CapitalBucket, CockpitFlow } from "../../../../shared/types";
import { hhmm, tooltipContentStyle, tooltipItemStyle, tooltipLabelStyle, tooltipTime } from "../../charts/simple/theme";
import { client } from "../../client";
import { signed, upDown } from "../../format";
import { theme } from "../../theme";
import { SectionTitle } from "../../ui";
import { useIntervalFetch } from "./useIntervalFetch";
import type { BinanceDerivativesSnapshot } from "../../../../packages/core/src/services/marketdata/types.js";

const BUCKET_LABEL: Record<string, string> = { large: "大单", medium: "中单", small: "小单" };
function Metric({ label, value }: { label: string; value: string }) { return <><div className="k">{label}</div><div className="v num">{value}</div></>; }

function DerivativesTab({ symbol }: { symbol: string }) {
  const { data, error } = useIntervalFetch<BinanceDerivativesSnapshot>(`symbols.derivatives:${symbol}`, () => client.symbols.derivatives({ sym: symbol }), 15_000);
  if (error) return <div className="note-block">合约行情获取失败：{error}</div>;
  if (!data) return <div className="note-block">加载中…</div>;
  const premium = data.mark?.indexPrice ? `${((data.mark.markPrice / data.mark.indexPrice - 1) * 100).toFixed(4)}%` : "--";
  const bid = data.depth?.bids[0], ask = data.depth?.asks[0];
  return <><SectionTitle>永续合约结构</SectionTitle><div className="grid2">
    <Metric label="类型" value={`${data.instrument.contractType} · ${data.instrument.underlyingType}`} /><Metric label="保证金" value={data.instrument.marginAsset} />
    <Metric label="标记价" value={data.mark?.markPrice.toLocaleString() ?? "--"} /><Metric label="指数价" value={data.mark?.indexPrice.toLocaleString() ?? "--"} />
    <Metric label="溢价" value={premium} /><Metric label="资金费率" value={data.mark ? `${(data.mark.lastFundingRate * 100).toFixed(4)}%` : "--"} />
    <Metric label="未平仓量" value={data.openInterest?.contracts.toLocaleString() ?? "--"} /><Metric label="OI 名义价值" value={data.openInterest?.notional?.toLocaleString() ?? "--"} />
  </div><SectionTitle>多空与订单流</SectionTitle><div className="grid2">
    <Metric label="全市场多空比" value={data.sentiment.globalAccounts?.longShortRatio.toFixed(3) ?? "--"} /><Metric label="大户账户比" value={data.sentiment.topAccounts?.longShortRatio.toFixed(3) ?? "--"} />
    <Metric label="大户持仓比" value={data.sentiment.topPositions?.longShortRatio.toFixed(3) ?? "--"} /><Metric label="主动买卖比" value={data.sentiment.taker?.buySellRatio.toFixed(3) ?? "--"} />
    <Metric label="买一" value={bid ? `${bid[0]} × ${bid[1]}` : "--"} /><Metric label="卖一" value={ask ? `${ask[0]} × ${ask[1]}` : "--"} />
    <Metric label="最近成交样本" value={String(data.recentTrades.length)} /><Metric label="已捕获强平" value={String(data.liquidations.length)} />
  </div><div className="note-block">资金费率历史 {data.fundingHistory.length} 条 · OI 历史 {data.openInterestHistory.length} 条 · 强平覆盖起点 {data.liquidationCoverageStartedAt ?? "连接中"}</div></>;
}

function BucketRow({ label, bucket }: { label: string; bucket: CapitalBucket }) {
  return (
    <>
      <div className="k">{label}</div>
      <div className={`v ${upDown(bucket.net)}`}>{signed(bucket.net, 0)}</div>
    </>
  );
}

function FlowMiniChart({ flow }: { flow: CockpitFlow }) {
  const data = flow.curve
    .map((p) => ({ t: p.time, v: p.value }))
    .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.v));
  return (
    <div style={{ width: "100%", height: 180 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={theme.border} vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={hhmm}
            tick={{ fill: theme.textSecondary, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: theme.borderStrong }}
            minTickGap={40}
          />
          <YAxis tick={{ fill: theme.textSecondary, fontSize: 10 }} tickLine={false} axisLine={false} width={50} />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            labelFormatter={(t) => tooltipTime(Number(t))}
            formatter={(value) => [Number(value).toLocaleString(), "净流入"]}
          />
          <ReferenceLine y={0} stroke={theme.borderStrong} />
          <Bar dataKey="v" isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.t} fill={d.v >= 0 ? theme.up : theme.down} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FlowTab({ symbol }: { symbol: string }) {
  if (/^[A-Z0-9]+USDT$/i.test(symbol)) return <DerivativesTab symbol={symbol} />;
  const { data: flow, error } = useIntervalFetch<CockpitFlow | null>(
    `symbols.flow:${symbol}`,
    () => client.symbols.flow({ sym: symbol }),
    60_000,
  );

  if (error) return <div className="note-block">资金流数据获取失败：{error}</div>;
  if (!flow) return <div className="note-block">加载中…</div>;

  return (
    <>
      <SectionTitle>资金净流入（原始数值，单位未知）</SectionTitle>
      <FlowMiniChart flow={flow} />
      {flow.distribution ? (
        <>
          <SectionTitle>大/中/小单净额</SectionTitle>
          <div className="grid2">
            <BucketRow label={BUCKET_LABEL.large} bucket={flow.distribution.large} />
            <BucketRow label={BUCKET_LABEL.medium} bucket={flow.distribution.medium} />
            <BucketRow label={BUCKET_LABEL.small} bucket={flow.distribution.small} />
          </div>
        </>
      ) : (
        <div className="note-block">分布暂不可用</div>
      )}
    </>
  );
}
