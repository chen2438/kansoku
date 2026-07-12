import { defineRoutes } from "./defineRoutes.js";

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
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number;
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

// 只读账户接口。本阶段刻意不含任何下单/撤单方法——实盘执行（Phase B）另行设计+批准。
export interface BinanceAccountApi {
  status(): Promise<BinanceAccountStatus>;
  connect(input: BinanceAccountConnectInput): Promise<BinanceAccountStatus>;
  disconnect(): Promise<{ ok: true }>;
  balance(): Promise<BinanceAccountBalance>;
  positions(): Promise<BinancePositionRow[]>;
  openOrders(): Promise<BinanceOpenOrderRow[]>;
}

export const binanceAccountRoutes = defineRoutes<BinanceAccountApi>("binanceAccount", {
  status: { method: "GET", path: "/status" },
  connect: { method: "POST", path: "/connect" },
  disconnect: { method: "DELETE", path: "/disconnect" },
  balance: { method: "GET", path: "/balance" },
  positions: { method: "GET", path: "/positions" },
  openOrders: { method: "GET", path: "/open-orders" },
});
