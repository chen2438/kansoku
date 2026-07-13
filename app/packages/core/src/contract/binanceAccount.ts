import { defineRoutes } from "./defineRoutes.js";
import type { BinanceBatchRanking } from "./symbols.js";

export type BinanceTradeSource = BinanceBatchRanking | "manual" | "mixed" | "unknown";

export interface BinanceAccountConnectInput {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export interface BinanceAccountStatus {
  configured: boolean;
  testnet: boolean;
  maskedKey: string | null;
  connected: boolean;
  lastError: string | null;
}

export interface BinanceBalanceAsset {
  asset: string;
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
}

export interface BinanceAccountBalance {
  totalWalletBalance: number;
  totalUnrealizedPnl: number;
  availableBalance: number;
  assets: BinanceBalanceAsset[];
}

export interface BinancePositionRow {
  symbol: string;
  side: "long" | "short" | "flat";
  positionAmt: number;
  entryPrice: number;
  breakEvenPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  netUnrealizedPnl: number;
  netUnrealizedPnlIncludesCosts: boolean;
  leverage: number;
  liquidationPrice: number;
  source: BinanceTradeSource;
}

export interface BinanceClosedPositionTrade {
  id: string;
  symbol: string;
  asset: string;
  realizedPnl: number;
  commission: number;
  fundingFee: number;
  otherAdjustments: number;
  netPnl: number;
  closedAt: number;
  closeCount: number;
  direction: "long" | "short" | "mixed" | "unknown";
  source: BinanceTradeSource;
  tradeId: string | null;
  transactionId: number | null;
}

export interface BinanceClosedPositionHistory {
  from: number;
  to: number;
  rows: BinanceClosedPositionTrade[];
}

export interface BinanceOpenOrderRow {
  symbol: string;
  orderId: number;
  side: string;
  type: string;
  price: number;
  stopPrice: number;
  origQty: number;
  status: string;
  reduceOnly: boolean;
  time: number;
}

export interface BinancePlaceTestnetOrderInput {
  symbol: string;
  direction: "LONG" | "SHORT";
  initialMargin: number;
  leverage: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  // 自动批次使用：下单前只要发现该标的已有持仓、普通挂单或条件单，就拒绝本次开仓。
  requireFlat?: boolean;
  // 自动批次使用稳定编号，避免同一批次重试时产生无法辨认的重复订单。
  clientOrderId?: string;
  // 保存自动榜单或人工下单来源，供当前持仓和历史平仓展示。
  source?: Exclude<BinanceTradeSource, "mixed" | "unknown">;
  // 页面必须在用户看过订单摘要并确认后才传 true；服务端仍会再次校验测试网。
  confirmed: boolean;
}

export interface BinancePlacedOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  side: string;
  type: string;
  status: string;
  quantity: number;
  executedQty: number;
  price: number;
  avgPrice: number;
  reduceOnly: boolean;
  updateTime: number;
}

export interface BinanceCancelTestnetOrderInput {
  symbol: string;
  orderId: number;
  confirmed: boolean;
}

export interface BinanceCloseTestnetPositionInput {
  symbol: string;
  direction: "LONG" | "SHORT";
  confirmed: boolean;
}

export interface BinanceCloseAllTestnetPositionsInput {
  confirmed: boolean;
}

export interface BinanceCloseAllTestnetPositionsResult {
  closed: BinancePlacedOrder[];
  failures: Array<{
    symbol: string;
    direction: "LONG" | "SHORT";
    error: string;
  }>;
}

export interface BinanceAlgoOrderResult {
  algoId: number;
  clientAlgoId: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  triggerPrice: number;
}

export interface BinanceOpenedPositionResult {
  direction: "LONG" | "SHORT";
  initialMargin: number;
  leverage: number;
  referencePrice: number;
  quantity: number;
  estimatedInitialMargin: number;
  entryOrder: BinancePlacedOrder;
  takeProfitOrder: BinanceAlgoOrderResult | null;
  stopLossOrder: BinanceAlgoOrderResult | null;
  protectionErrors: string[];
}

// 账户接口默认只读；唯一写操作是经过手动确认的测试网订单，主网下单在服务端硬性禁止。
export interface BinanceAccountApi {
  status(): Promise<BinanceAccountStatus>;
  connect(input: BinanceAccountConnectInput): Promise<BinanceAccountStatus>;
  disconnect(): Promise<{ ok: true }>;
  balance(): Promise<BinanceAccountBalance>;
  positions(): Promise<BinancePositionRow[]>;
  closedPositionHistory(): Promise<BinanceClosedPositionHistory>;
  openOrders(): Promise<BinanceOpenOrderRow[]>;
  placeTestnetOrder(input: BinancePlaceTestnetOrderInput): Promise<BinanceOpenedPositionResult>;
  closeTestnetPosition(input: BinanceCloseTestnetPositionInput): Promise<BinancePlacedOrder>;
  closeAllTestnetPositions(input: BinanceCloseAllTestnetPositionsInput): Promise<BinanceCloseAllTestnetPositionsResult>;
  cancelTestnetOrder(input: BinanceCancelTestnetOrderInput): Promise<BinancePlacedOrder>;
}

export const binanceAccountRoutes = defineRoutes<BinanceAccountApi>("binanceAccount", {
  status: { method: "GET", path: "/status" },
  connect: { method: "POST", path: "/connect" },
  disconnect: { method: "DELETE", path: "/disconnect" },
  balance: { method: "GET", path: "/balance" },
  positions: { method: "GET", path: "/positions" },
  closedPositionHistory: { method: "GET", path: "/closed-position-history" },
  openOrders: { method: "GET", path: "/open-orders" },
  placeTestnetOrder: { method: "POST", path: "/testnet/orders" },
  closeTestnetPosition: { method: "POST", path: "/testnet/positions/close" },
  closeAllTestnetPositions: { method: "POST", path: "/testnet/positions/close-all" },
  cancelTestnetOrder: { method: "POST", path: "/testnet/orders/cancel" },
});
