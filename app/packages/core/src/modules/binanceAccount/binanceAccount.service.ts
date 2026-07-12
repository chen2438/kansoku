import type {
  BinanceAccountApi,
  BinanceAccountConnectInput,
  BinanceAccountStatus,
} from "../../contract/binanceAccount.js";
import { ClientError } from "../../errors.js";
import { getAiRuntime } from "../../ai/initAiSettings.js";
import {
  type BinanceAccountCreds,
  binanceAccountBalance,
  binanceOpenOrders,
  binancePing,
  binancePositions,
} from "../../services/marketdata/binanceAccount.js";

// 复用现有加密凭证库（AES + provider_credentials 表）。三样字段 JSON 编码进 api_key 的 key。
const PROVIDER = "binance-account";

function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

async function loadCreds(): Promise<BinanceAccountCreds | null> {
  const cred = await getAiRuntime().credentials.read(PROVIDER);
  if (!cred || cred.type !== "api_key" || !cred.key) return null;
  try {
    const parsed = JSON.parse(cred.key) as Partial<BinanceAccountCreds>;
    if (!parsed.apiKey || !parsed.apiSecret) return null;
    return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret, testnet: Boolean(parsed.testnet) };
  } catch {
    return null;
  }
}

function requireCreds(creds: BinanceAccountCreds | null): asserts creds is BinanceAccountCreds {
  if (!creds) throw new ClientError("尚未连接 Binance 账号", "请先在设置里填入 API key/secret 并连接", 400);
}

async function statusFrom(creds: BinanceAccountCreds | null): Promise<BinanceAccountStatus> {
  if (!creds) {
    return { configured: false, testnet: true, maskedKey: null, connected: false, lastError: null };
  }
  try {
    await binancePing(creds);
    return { configured: true, testnet: creds.testnet, maskedKey: maskKey(creds.apiKey), connected: true, lastError: null };
  } catch (error) {
    return {
      configured: true,
      testnet: creds.testnet,
      maskedKey: maskKey(creds.apiKey),
      connected: false,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

export const binanceAccountService: BinanceAccountApi = {
  async status() {
    return statusFrom(await loadCreds());
  },

  async connect(input: BinanceAccountConnectInput) {
    const apiKey = String(input?.apiKey ?? "").trim();
    const apiSecret = String(input?.apiSecret ?? "").trim();
    if (!apiKey || !apiSecret) {
      throw new ClientError("API key 和 secret 都不能为空", "在设置里两个字段都填上", 400);
    }
    const creds: BinanceAccountCreds = { apiKey, apiSecret, testnet: Boolean(input?.testnet) };
    // 先验证再落库——凭证无效就不写入。
    await binancePing(creds);
    getAiRuntime().credentials.setApiKey(PROVIDER, JSON.stringify(creds));
    return statusFrom(creds);
  },

  async disconnect() {
    await getAiRuntime().credentials.delete(PROVIDER);
    return { ok: true as const };
  },

  async balance() {
    const creds = await loadCreds();
    requireCreds(creds);
    return binanceAccountBalance(creds);
  },

  async positions() {
    const creds = await loadCreds();
    requireCreds(creds);
    return binancePositions(creds);
  },

  async openOrders() {
    const creds = await loadCreds();
    requireCreds(creds);
    return binanceOpenOrders(creds);
  },
};
