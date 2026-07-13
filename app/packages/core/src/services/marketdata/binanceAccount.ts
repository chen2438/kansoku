import { createHmac } from "node:crypto";
import { ClientError } from "../../errors.js";
import type {
  BinanceAccountBalance,
  BinanceAlgoOrderResult,
  BinanceCancelTestnetOrderInput,
  BinanceCloseAllTestnetPositionsInput,
  BinanceCloseAllTestnetPositionsResult,
  BinanceCloseTestnetPositionInput,
  BinanceClosedPositionHistory,
  BinanceClosedPositionSummary,
  BinanceOpenOrderRow,
  BinanceOpenedPositionResult,
  BinancePlacedOrder,
  BinancePlaceTestnetOrderInput,
  BinancePositionRow,
} from "../../contract/binanceAccount.js";

// 主网真账号；测试网用 testnet.binancefuture.com——不碰真钱，Phase A 默认。
const MAINNET = process.env.BINANCE_FUTURES_REST_URL ?? "https://fapi.binance.com";
const TESTNET = process.env.BINANCE_FUTURES_TESTNET_URL ?? "https://testnet.binancefuture.com";
const RECV_WINDOW = 5000;

export interface BinanceAccountCreds {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

function baseFor(creds: BinanceAccountCreds): string {
  return creds.testnet ? TESTNET : MAINNET;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// 签名 = HMAC-SHA256(查询串, apiSecret)。抽出便于单测（对照 Binance 文档示例）。
export function signQuery(apiSecret: string, query: string): string {
  return createHmac("sha256", apiSecret).update(query).digest("hex");
}

// 只读签名 GET。签名 = HMAC-SHA256(查询串, apiSecret)，头带 X-MBX-APIKEY。
async function signedGet<T>(
  creds: BinanceAccountCreds,
  path: string,
  params = new URLSearchParams(),
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  params.set("timestamp", String(Date.now()));
  params.set("recvWindow", String(RECV_WINDOW));
  const query = params.toString();
  const signature = signQuery(creds.apiSecret, query);
  const url = new URL(path, baseFor(creds));
  url.search = `${query}&signature=${signature}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "X-MBX-APIKEY": creds.apiKey },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const text = await response.text();
      const hint =
        response.status === 401
          ? "API key/secret 无效或权限不足"
          : "检查 API 权限（需读取权限）、IP 白名单与测试网/主网开关是否匹配";
      throw new ClientError(`binance account ${path} failed: ${response.status} ${text}`, hint, 502);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      `binance account ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      "检查网络连通性与 Binance 期货接口可用性",
      502,
    );
  }
}

async function publicGet<T>(
  creds: BinanceAccountCreds,
  path: string,
  params: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = new URL(path, baseFor(creds));
  url.search = params.toString();
  try {
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      throw new ClientError(
        `binance account ${path} failed: ${response.status} ${await response.text()}`,
        "检查交易对是否存在，以及 Binance 期货测试网是否可用",
        502,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      `binance account ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      "检查网络连通性与 Binance 期货测试网接口可用性",
      502,
    );
  }
}

// Binance 要求先对编码后的参数串签名，再把同一串参数作为表单发送。
async function signedPost<T>(
  creds: BinanceAccountCreds,
  path: string,
  params: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  params.set("timestamp", String(Date.now()));
  params.set("recvWindow", String(RECV_WINDOW));
  const query = params.toString();
  const body = `${query}&signature=${signQuery(creds.apiSecret, query)}`;
  try {
    const response = await fetchImpl(new URL(path, baseFor(creds)), {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": creds.apiKey,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const text = await response.text();
      let code: number | null = null;
      try { code = num((JSON.parse(text) as { code?: unknown }).code); } catch { /* Binance 偶尔返回非 JSON 文本。 */ }
      if (code === -4411) {
        const symbol = params.get("symbol") ?? "该 TradFi 合约";
        throw new ClientError(
          `Binance 拒绝 ${symbol} 操作：当前测试网账号尚未签署 TradFi Perps 协议（错误 -4411）`,
          "请本人登录与此 API key 对应的 Binance Futures 测试网账户，进入 TradFi 或该合约交易页，按页面提示阅读并接受协议后重试；如果测试网页面没有开通入口，该测试网账号暂时无法交易 TradFi 合约",
          400,
          "BINANCE_TRADFI_AGREEMENT_REQUIRED",
        );
      }
      const hint =
        response.status === 401
          ? "API key/secret 无效，或测试网 API key 没有交易权限"
          : "检查交易对、数量、价格精度、可用保证金和测试网 API 交易权限";
      throw new ClientError(`binance account ${path} failed: ${response.status} ${text}`, hint, 502);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      `binance account ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      "检查网络连通性与 Binance 期货测试网接口可用性",
      502,
    );
  }
}

async function signedDelete<T>(
  creds: BinanceAccountCreds,
  path: string,
  params: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  params.set("timestamp", String(Date.now()));
  params.set("recvWindow", String(RECV_WINDOW));
  const query = params.toString();
  const url = new URL(path, baseFor(creds));
  url.search = `${query}&signature=${signQuery(creds.apiSecret, query)}`;
  try {
    const response = await fetchImpl(url, {
      method: "DELETE",
      headers: { "X-MBX-APIKEY": creds.apiKey },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ClientError(
        `binance account ${path} failed: ${response.status} ${text}`,
        "检查订单是否仍在挂单、交易对和测试网 API 交易权限",
        502,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      `binance account ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      "检查网络连通性与 Binance 期货测试网接口可用性",
      502,
    );
  }
}

// 连通性 + 凭证有效性自检（拉一次账户即可验证签名与权限）。
export async function binancePing(creds: BinanceAccountCreds): Promise<void> {
  await signedGet<unknown>(creds, "/fapi/v2/account");
}

interface RawAccount {
  totalWalletBalance?: string;
  totalUnrealizedProfit?: string;
  availableBalance?: string;
  assets?: Array<{ asset: string; walletBalance: string; availableBalance: string; unrealizedProfit: string }>;
}

export async function binanceAccountBalance(creds: BinanceAccountCreds): Promise<BinanceAccountBalance> {
  const raw = await signedGet<RawAccount>(creds, "/fapi/v2/account");
  const assets = (raw.assets ?? [])
    .map((a) => ({
      asset: a.asset,
      walletBalance: num(a.walletBalance),
      availableBalance: num(a.availableBalance),
      unrealizedPnl: num(a.unrealizedProfit),
    }))
    .filter((a) => a.walletBalance !== 0 || a.availableBalance !== 0 || a.unrealizedPnl !== 0);
  return {
    totalWalletBalance: num(raw.totalWalletBalance),
    totalUnrealizedPnl: num(raw.totalUnrealizedProfit),
    availableBalance: num(raw.availableBalance),
    assets,
  };
}

interface RawPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string;
  liquidationPrice: string;
  positionSide?: string;
}

export async function binancePositions(creds: BinanceAccountCreds): Promise<BinancePositionRow[]> {
  const raw = await signedGet<RawPosition[]>(creds, "/fapi/v2/positionRisk");
  return (raw ?? [])
    .map((p) => {
      const amt = num(p.positionAmt);
      const side = p.positionSide === "LONG"
        ? ("long" as const)
        : p.positionSide === "SHORT"
          ? ("short" as const)
          : amt > 0 ? ("long" as const) : amt < 0 ? ("short" as const) : ("flat" as const);
      return {
        symbol: p.symbol,
        side,
        positionAmt: amt,
        entryPrice: num(p.entryPrice),
        markPrice: num(p.markPrice),
        unrealizedPnl: num(p.unRealizedProfit),
        leverage: num(p.leverage),
        liquidationPrice: num(p.liquidationPrice),
      };
    })
    .filter((p) => p.positionAmt !== 0);
}

interface RawIncomeRow {
  symbol?: string;
  incomeType?: string;
  income?: string;
  asset?: string;
  time?: number;
  tranId?: number;
  tradeId?: string;
}

const CLOSED_POSITION_INCOME_TYPES = new Set([
  "REALIZED_PNL",
  "COMMISSION",
  "FUNDING_FEE",
  "INSURANCE_CLEAR",
  "COMMISSION_REBATE",
  "API_REBATE",
  "FEE_RETURN",
  "POSITION_LIMIT_INCREASE_FEE",
]);

export function summarizeBinanceClosedPositions(rawRows: RawIncomeRow[]): BinanceClosedPositionSummary[] {
  const rows = rawRows.filter((row) => row.symbol && row.asset && CLOSED_POSITION_INCOME_TYPES.has(row.incomeType ?? ""));
  const closedKeys = new Set(
    rows
      .filter((row) => row.incomeType === "REALIZED_PNL")
      .map((row) => `${row.symbol}:${row.asset}`),
  );
  const summaries = new Map<string, BinanceClosedPositionSummary>();

  for (const row of rows) {
    const key = `${row.symbol}:${row.asset}`;
    if (!closedKeys.has(key)) continue;
    const summary = summaries.get(key) ?? {
      symbol: row.symbol!,
      asset: row.asset!,
      realizedPnl: 0,
      commission: 0,
      fundingFee: 0,
      otherAdjustments: 0,
      netPnl: 0,
      lastClosedAt: 0,
      realizedEventCount: 0,
    };
    const income = num(row.income);
    if (row.incomeType === "REALIZED_PNL") {
      summary.realizedPnl += income;
      summary.realizedEventCount += 1;
      summary.lastClosedAt = Math.max(summary.lastClosedAt, num(row.time));
    } else if (row.incomeType === "COMMISSION") {
      summary.commission += income;
    } else if (row.incomeType === "FUNDING_FEE") {
      summary.fundingFee += income;
    } else {
      summary.otherAdjustments += income;
    }
    summaries.set(key, summary);
  }

  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      netPnl: summary.realizedPnl + summary.commission + summary.fundingFee + summary.otherAdjustments,
    }))
    .sort((a, b) => b.lastClosedAt - a.lastClosedAt || a.symbol.localeCompare(b.symbol));
}

export async function binanceClosedPositionHistory(
  creds: BinanceAccountCreds,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<BinanceClosedPositionHistory> {
  const from = now - 90 * 24 * 60 * 60 * 1000;
  const rawRows: RawIncomeRow[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= 20; page += 1) {
    const params = new URLSearchParams({
      startTime: String(from),
      endTime: String(now),
      page: String(page),
      limit: "1000",
    });
    const pageRows = await signedGet<RawIncomeRow[]>(creds, "/fapi/v1/income", params, fetchImpl);
    for (const row of pageRows ?? []) {
      const key = `${row.incomeType ?? ""}:${row.tranId ?? ""}:${row.tradeId ?? ""}:${row.asset ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rawRows.push(row);
    }
    if (!pageRows || pageRows.length < 1000) break;
  }

  return { from, to: now, rows: summarizeBinanceClosedPositions(rawRows) };
}

interface RawOpenOrder {
  symbol: string;
  orderId: number;
  side: string;
  type: string;
  price: string;
  stopPrice: string;
  origQty: string;
  status: string;
  reduceOnly: boolean;
  time: number;
}

export async function binanceOpenOrders(creds: BinanceAccountCreds): Promise<BinanceOpenOrderRow[]> {
  const raw = await signedGet<RawOpenOrder[]>(creds, "/fapi/v1/openOrders");
  return (raw ?? []).map((o) => ({
    symbol: o.symbol,
    orderId: o.orderId,
    side: o.side,
    type: o.type,
    price: num(o.price),
    stopPrice: num(o.stopPrice),
    origQty: num(o.origQty),
    status: o.status,
    reduceOnly: Boolean(o.reduceOnly),
    time: num(o.time),
  }));
}

interface RawPlacedOrder {
  symbol?: string;
  orderId?: number;
  clientOrderId?: string;
  side?: string;
  type?: string;
  status?: string;
  origQty?: string;
  executedQty?: string;
  price?: string;
  avgPrice?: string;
  reduceOnly?: boolean;
  updateTime?: number;
}

interface RawExchangeInfo {
  symbols?: Array<{
    symbol?: string;
    filters?: Array<{
      filterType?: string;
      minQty?: string;
      maxQty?: string;
      stepSize?: string;
      minPrice?: string;
      maxPrice?: string;
      tickSize?: string;
      notional?: string;
    }>;
  }>;
}

interface RawAlgoOrder {
  algoId?: number;
  clientAlgoId?: string;
  symbol?: string;
  side?: string;
  orderType?: string;
  algoStatus?: string;
  triggerPrice?: string;
}

function rawPositionDirection(position: RawPosition): "LONG" | "SHORT" {
  if (position.positionSide === "LONG" || position.positionSide === "SHORT") return position.positionSide;
  return num(position.positionAmt) >= 0 ? "LONG" : "SHORT";
}

function decimalPlaces(step: string): number {
  const normalized = step.replace(/0+$/, "");
  const dot = normalized.indexOf(".");
  return dot === -1 ? 0 : normalized.length - dot - 1;
}

function floorToStep(value: number, step: number, stepText: string): string {
  const places = decimalPlaces(stepText);
  const units = Math.floor((value + Number.EPSILON) / step);
  return (units * step).toFixed(places);
}

function isStepAligned(value: number, step: number): boolean {
  const units = value / step;
  return Math.abs(units - Math.round(units)) < 1e-8;
}

function placedOrder(raw: RawPlacedOrder, fallback: { symbol: string; side: string; quantity: number }): BinancePlacedOrder {
  return {
    symbol: String(raw.symbol ?? fallback.symbol),
    orderId: num(raw.orderId),
    clientOrderId: String(raw.clientOrderId ?? ""),
    side: String(raw.side ?? fallback.side),
    type: String(raw.type ?? "MARKET"),
    status: String(raw.status ?? "UNKNOWN"),
    quantity: num(raw.origQty ?? fallback.quantity),
    executedQty: num(raw.executedQty),
    price: num(raw.price),
    avgPrice: num(raw.avgPrice),
    reduceOnly: Boolean(raw.reduceOnly),
    updateTime: num(raw.updateTime),
  };
}

function algoOrder(raw: RawAlgoOrder, fallback: { symbol: string; side: string; type: string; triggerPrice: number }): BinanceAlgoOrderResult {
  return {
    algoId: num(raw.algoId),
    clientAlgoId: String(raw.clientAlgoId ?? ""),
    symbol: String(raw.symbol ?? fallback.symbol),
    side: String(raw.side ?? fallback.side),
    type: String(raw.orderType ?? fallback.type),
    status: String(raw.algoStatus ?? "NEW"),
    triggerPrice: num(raw.triggerPrice ?? fallback.triggerPrice),
  };
}

export async function binancePlaceTestnetOrder(
  creds: BinanceAccountCreds,
  input: BinancePlaceTestnetOrderInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BinanceOpenedPositionResult> {
  if (!creds.testnet) {
    throw new ClientError("主网下单已禁止", "请连接 Binance 期货测试网账号后再下单", 403, "BINANCE_MAINNET_ORDER_BLOCKED");
  }
  if (input?.confirmed !== true) {
    throw new ClientError("订单尚未手动确认", "请先核对订单摘要并确认", 400, "BINANCE_ORDER_NOT_CONFIRMED");
  }

  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
    throw new ClientError("交易对格式不正确", "请输入 Binance USD-M 的 USDT 永续合约，例如 BTCUSDT", 400);
  }
  if (input.direction !== "LONG" && input.direction !== "SHORT") {
    throw new ClientError("开仓方向不正确", "请选择开多或开空", 400);
  }
  const initialMargin = Number(input.initialMargin);
  if (!Number.isFinite(initialMargin) || initialMargin <= 0) {
    throw new ClientError("初始保证金必须大于 0", "请输入计划投入的 USDT 金额", 400);
  }
  const leverage = Number(input.leverage);
  if (!Number.isSafeInteger(leverage) || leverage < 1 || leverage > 125) {
    throw new ClientError("杠杆倍数必须是 1 到 125 的整数", "请输入 Binance 允许的杠杆倍数", 400);
  }
  const takeProfitPrice = input.takeProfitPrice == null ? null : Number(input.takeProfitPrice);
  const stopLossPrice = input.stopLossPrice == null ? null : Number(input.stopLossPrice);
  if (takeProfitPrice !== null && (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0)) {
    throw new ClientError("止盈价格必须大于 0", "不需要止盈时请留空", 400);
  }
  if (stopLossPrice !== null && (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0)) {
    throw new ClientError("止损价格必须大于 0", "不需要止损时请留空", 400);
  }
  const clientOrderId = input.clientOrderId == null ? null : String(input.clientOrderId).trim();
  if (clientOrderId !== null && (!/^[.A-Za-z0-9_:/-]{1,30}$/.test(clientOrderId))) {
    throw new ClientError("订单编号格式不正确", "订单编号只能使用字母、数字及 . _ : / -，且最多 30 个字符", 400);
  }

  if (input.requireFlat === true) {
    const symbolParams = () => new URLSearchParams({ symbol });
    const [livePositions, openOrders, openAlgoOrders] = await Promise.all([
      signedGet<RawPosition[]>(creds, "/fapi/v2/positionRisk", symbolParams(), fetchImpl),
      signedGet<RawOpenOrder[]>(creds, "/fapi/v1/openOrders", symbolParams(), fetchImpl),
      signedGet<RawAlgoOrder[] | RawAlgoOrder>(creds, "/fapi/v1/openAlgoOrders", symbolParams(), fetchImpl),
    ]);
    const activePositions = (livePositions ?? []).filter((position) => position.symbol === symbol && num(position.positionAmt) !== 0);
    if (activePositions.length > 0) {
      const directions = [...new Set(activePositions.map(rawPositionDirection))]
        .map((direction) => direction === "LONG" ? "多仓" : "空仓")
        .join("和");
      throw new ClientError(
        `${symbol} 已有${directions}，自动批次已跳过，不加仓、不平仓、不反手`,
        "如需执行新分析，请先在设置页人工处理现有仓位",
        409,
        "BINANCE_EXISTING_EXPOSURE",
      );
    }
    const regularCount = (openOrders ?? []).length;
    const algoCount = Array.isArray(openAlgoOrders) ? openAlgoOrders.length : openAlgoOrders ? 1 : 0;
    if (regularCount > 0 || algoCount > 0) {
      const details = [regularCount > 0 ? `${regularCount} 个普通挂单` : "", algoCount > 0 ? `${algoCount} 个条件单` : ""]
        .filter(Boolean)
        .join("、");
      throw new ClientError(
        `${symbol} 已有${details}，自动批次已跳过，避免重复订单`,
        "请先核对并处理现有订单后再运行批量下单",
        409,
        "BINANCE_EXISTING_EXPOSURE",
      );
    }
  }

  const [markRaw, exchangeInfo, positionMode] = await Promise.all([
    publicGet<{ markPrice?: string }>(creds, "/fapi/v1/premiumIndex", new URLSearchParams({ symbol }), fetchImpl),
    publicGet<RawExchangeInfo>(creds, "/fapi/v1/exchangeInfo", new URLSearchParams({ symbol }), fetchImpl),
    signedGet<{ dualSidePosition?: boolean }>(creds, "/fapi/v1/positionSide/dual", new URLSearchParams(), fetchImpl),
  ]);
  const referencePrice = num(markRaw.markPrice);
  if (referencePrice <= 0) throw new ClientError("无法取得标记价格", "稍后刷新重试", 502);
  if (input.direction === "LONG" && takeProfitPrice !== null && takeProfitPrice <= referencePrice) {
    throw new ClientError("开多的止盈价必须高于当前标记价格", `当前标记价格约为 ${referencePrice}`, 400);
  }
  if (input.direction === "LONG" && stopLossPrice !== null && stopLossPrice >= referencePrice) {
    throw new ClientError("开多的止损价必须低于当前标记价格", `当前标记价格约为 ${referencePrice}`, 400);
  }
  if (input.direction === "SHORT" && takeProfitPrice !== null && takeProfitPrice >= referencePrice) {
    throw new ClientError("开空的止盈价必须低于当前标记价格", `当前标记价格约为 ${referencePrice}`, 400);
  }
  if (input.direction === "SHORT" && stopLossPrice !== null && stopLossPrice <= referencePrice) {
    throw new ClientError("开空的止损价必须高于当前标记价格", `当前标记价格约为 ${referencePrice}`, 400);
  }

  const symbolInfo = exchangeInfo.symbols?.find((item) => item.symbol === symbol);
  const priceFilter = symbolInfo?.filters?.find((filter) => filter.filterType === "PRICE_FILTER");
  const tickSize = num(priceFilter?.tickSize);
  for (const [name, value] of [["止盈", takeProfitPrice], ["止损", stopLossPrice]] as const) {
    if (value === null) continue;
    if (tickSize > 0 && !isStepAligned(value, tickSize)) {
      throw new ClientError(`${name}价格不符合该合约的价格精度`, `价格必须是 ${priceFilter?.tickSize} 的整数倍`, 400);
    }
    const minPrice = num(priceFilter?.minPrice);
    const maxPrice = num(priceFilter?.maxPrice);
    if ((minPrice > 0 && value < minPrice) || (maxPrice > 0 && value > maxPrice)) {
      throw new ClientError(`${name}价格超出该合约允许范围`, `允许范围为 ${minPrice} 至 ${maxPrice}`, 400);
    }
  }
  const lot = symbolInfo?.filters?.find((filter) => filter.filterType === "MARKET_LOT_SIZE")
    ?? symbolInfo?.filters?.find((filter) => filter.filterType === "LOT_SIZE");
  const stepText = String(lot?.stepSize ?? "");
  const step = num(stepText);
  if (!symbolInfo || step <= 0) throw new ClientError("无法取得合约数量规则", "确认交易对存在后重试", 400);
  const quantityText = floorToStep((initialMargin * leverage) / referencePrice, step, stepText);
  const quantity = num(quantityText);
  const minQty = num(lot?.minQty);
  const maxQty = num(lot?.maxQty);
  if (quantity <= 0 || (minQty > 0 && quantity < minQty) || (maxQty > 0 && quantity > maxQty)) {
    throw new ClientError("按保证金计算出的下单数量不符合合约限制", `当前计算数量 ${quantityText}，请提高保证金或调整杠杆`, 400);
  }
  const minNotional = num(symbolInfo.filters?.find((filter) => filter.filterType === "MIN_NOTIONAL")?.notional);
  if (minNotional > 0 && quantity * referencePrice < minNotional) {
    throw new ClientError("仓位金额低于最小下单金额", `至少需要约 ${minNotional} USDT 的仓位金额`, 400);
  }

  const leverageRaw = await signedPost<{ leverage?: number }>(
    creds,
    "/fapi/v1/leverage",
    new URLSearchParams({ symbol, leverage: String(leverage) }),
    fetchImpl,
  );
  const actualLeverage = num(leverageRaw.leverage) || leverage;
  const entrySide = input.direction === "LONG" ? "BUY" : "SELL";
  const closeSide = input.direction === "LONG" ? "SELL" : "BUY";
  const positionSide = positionMode.dualSidePosition ? input.direction : null;
  const entryParams = new URLSearchParams({
    symbol,
    side: entrySide,
    type: "MARKET",
    quantity: quantityText,
    newOrderRespType: "RESULT",
  });
  if (clientOrderId) entryParams.set("newClientOrderId", clientOrderId);
  if (positionSide) entryParams.set("positionSide", positionSide);
  const entryRaw = await signedPost<RawPlacedOrder>(creds, "/fapi/v1/order", entryParams, fetchImpl);
  const entryOrder = placedOrder(entryRaw, { symbol, side: entrySide, quantity });

  const protectionErrors: string[] = [];
  const placeProtection = async (type: "TAKE_PROFIT_MARKET" | "STOP_MARKET", triggerPrice: number) => {
    const params = new URLSearchParams({
      algoType: "CONDITIONAL",
      symbol,
      side: closeSide,
      type,
      triggerPrice: String(triggerPrice),
      workingType: "MARK_PRICE",
      closePosition: "true",
    });
    if (clientOrderId) params.set("clientAlgoId", `${clientOrderId}-${type === "TAKE_PROFIT_MARKET" ? "tp" : "sl"}`);
    if (positionSide) params.set("positionSide", positionSide);
    const raw = await signedPost<RawAlgoOrder>(creds, "/fapi/v1/algoOrder", params, fetchImpl);
    return algoOrder(raw, { symbol, side: closeSide, type, triggerPrice });
  };
  let takeProfitOrder: BinanceAlgoOrderResult | null = null;
  let stopLossOrder: BinanceAlgoOrderResult | null = null;
  if (takeProfitPrice !== null) {
    try { takeProfitOrder = await placeProtection("TAKE_PROFIT_MARKET", takeProfitPrice); }
    catch (error) { protectionErrors.push(`止盈单失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  if (stopLossPrice !== null) {
    try { stopLossOrder = await placeProtection("STOP_MARKET", stopLossPrice); }
    catch (error) { protectionErrors.push(`止损单失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  const fillPrice = entryOrder.avgPrice > 0 ? entryOrder.avgPrice : referencePrice;
  return {
    direction: input.direction,
    initialMargin,
    leverage: actualLeverage,
    referencePrice,
    quantity,
    estimatedInitialMargin: (quantity * fillPrice) / actualLeverage,
    entryOrder,
    takeProfitOrder,
    stopLossOrder,
    protectionErrors,
  };
}

export async function binanceCloseTestnetPosition(
  creds: BinanceAccountCreds,
  input: BinanceCloseTestnetPositionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BinancePlacedOrder> {
  if (!creds.testnet) {
    throw new ClientError("主网平仓已禁止", "请连接 Binance 期货测试网账号后再操作", 403, "BINANCE_MAINNET_ORDER_BLOCKED");
  }
  if (input?.confirmed !== true) {
    throw new ClientError("平仓尚未确认", "请先核对持仓并确认市价平仓", 400, "BINANCE_ORDER_NOT_CONFIRMED");
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || (input.direction !== "LONG" && input.direction !== "SHORT")) {
    throw new ClientError("平仓参数不正确", "请刷新持仓列表后重试", 400);
  }

  // 不相信页面缓存的数量；提交前重新读取测试网当前持仓，按全部实时数量平仓。
  const positions = await signedGet<RawPosition[]>(
    creds,
    "/fapi/v2/positionRisk",
    new URLSearchParams({ symbol }),
    fetchImpl,
  );
  const target = (positions ?? []).find((position) => {
    if (position.symbol !== symbol || num(position.positionAmt) === 0) return false;
    const direction = position.positionSide === "LONG" || position.positionSide === "SHORT"
      ? position.positionSide
      : num(position.positionAmt) > 0 ? "LONG" : "SHORT";
    return direction === input.direction;
  });
  if (!target) {
    throw new ClientError("找不到要平掉的测试网持仓", "持仓可能已经变化，请刷新后重试", 409);
  }

  const quantityText = String(target.positionAmt).replace(/^-/, "");
  const side = input.direction === "LONG" ? "SELL" : "BUY";
  const params = new URLSearchParams({
    symbol,
    side,
    type: "MARKET",
    quantity: quantityText,
    newOrderRespType: "RESULT",
  });
  if (target.positionSide === "LONG" || target.positionSide === "SHORT") {
    params.set("positionSide", target.positionSide);
  } else {
    params.set("reduceOnly", "true");
  }
  const raw = await signedPost<RawPlacedOrder>(creds, "/fapi/v1/order", params, fetchImpl);
  return placedOrder(raw, { symbol, side, quantity: num(quantityText) });
}

export async function binanceCloseAllTestnetPositions(
  creds: BinanceAccountCreds,
  input: BinanceCloseAllTestnetPositionsInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BinanceCloseAllTestnetPositionsResult> {
  if (!creds.testnet) {
    throw new ClientError("主网全部平仓已禁止", "请连接 Binance 期货测试网账号后再操作", 403, "BINANCE_MAINNET_ORDER_BLOCKED");
  }
  if (!input?.confirmed) {
    throw new ClientError("全部平仓尚未确认", "请先核对所有持仓并确认市价平仓", 400, "BINANCE_ORDER_NOT_CONFIRMED");
  }

  const livePositions = await signedGet<RawPosition[]>(creds, "/fapi/v2/positionRisk", new URLSearchParams(), fetchImpl);
  const targets = (livePositions ?? []).filter((position) => num(position.positionAmt) !== 0);
  const result: BinanceCloseAllTestnetPositionsResult = { closed: [], failures: [] };

  for (const position of targets) {
    const direction = rawPositionDirection(position);
    try {
      result.closed.push(await binanceCloseTestnetPosition(
        creds,
        { symbol: position.symbol, direction, confirmed: true },
        fetchImpl,
      ));
    } catch (error) {
      result.failures.push({
        symbol: position.symbol,
        direction,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export async function binanceCancelTestnetOrder(
  creds: BinanceAccountCreds,
  input: BinanceCancelTestnetOrderInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BinancePlacedOrder> {
  if (!creds.testnet) {
    throw new ClientError("主网撤单已禁止", "请连接 Binance 期货测试网账号后再操作", 403, "BINANCE_MAINNET_ORDER_BLOCKED");
  }
  if (input?.confirmed !== true) {
    throw new ClientError("撤单尚未手动确认", "请先核对订单并确认撤单", 400, "BINANCE_ORDER_NOT_CONFIRMED");
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const orderId = Number(input.orderId);
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || !Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new ClientError("撤单参数不正确", "请刷新挂单列表后重试", 400);
  }

  const raw = await signedDelete<RawPlacedOrder>(
    creds,
    "/fapi/v1/order",
    new URLSearchParams({ symbol, orderId: String(orderId) }),
    fetchImpl,
  );
  return {
    symbol: String(raw.symbol ?? symbol),
    orderId: num(raw.orderId ?? orderId),
    clientOrderId: String(raw.clientOrderId ?? ""),
    side: String(raw.side ?? ""),
    type: String(raw.type ?? ""),
    status: String(raw.status ?? "CANCELED"),
    quantity: num(raw.origQty),
    executedQty: num(raw.executedQty),
    price: num(raw.price),
    avgPrice: num(raw.avgPrice),
    reduceOnly: Boolean(raw.reduceOnly),
    updateTime: num(raw.updateTime),
  };
}
