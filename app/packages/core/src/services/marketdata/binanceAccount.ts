import { createHmac } from "node:crypto";
import { ClientError } from "../../errors.js";
import type {
  BinanceAccountBalance,
  BinanceOpenOrderRow,
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
async function signedGet<T>(creds: BinanceAccountCreds, path: string): Promise<T> {
  const query = `timestamp=${Date.now()}&recvWindow=${RECV_WINDOW}`;
  const signature = signQuery(creds.apiSecret, query);
  const url = new URL(path, baseFor(creds));
  url.search = `${query}&signature=${signature}`;
  try {
    const response = await fetch(url, {
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
}

export async function binancePositions(creds: BinanceAccountCreds): Promise<BinancePositionRow[]> {
  const raw = await signedGet<RawPosition[]>(creds, "/fapi/v2/positionRisk");
  return (raw ?? [])
    .map((p) => {
      const amt = num(p.positionAmt);
      return {
        symbol: p.symbol,
        side: amt > 0 ? ("long" as const) : amt < 0 ? ("short" as const) : ("flat" as const),
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
