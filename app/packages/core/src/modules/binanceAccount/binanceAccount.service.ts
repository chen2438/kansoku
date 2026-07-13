import type {
  BinanceAccountApi,
  BinanceAccountConnectInput,
  BinanceClosedPositionHistory,
  BinancePositionRow,
  BinanceAccountStatus,
  BinanceTradeSource,
} from "../../contract/binanceAccount.js";
import { ClientError } from "../../errors.js";
import { getAiRuntime } from "../../ai/initAiSettings.js";
import {
  type BinanceAccountCreds,
  binanceAccountBalance,
  binanceCancelTestnetOrder,
  binanceCloseAllTestnetPositions,
  binanceCloseTestnetPosition,
  binanceClosedPositionHistory,
  binanceOpenOrders,
  binancePing,
  binancePlaceTestnetOrder,
  binancePositions,
} from "../../services/marketdata/binanceAccount.js";

// 复用现有加密凭证库（AES + provider_credentials 表）。三样字段 JSON 编码进 api_key 的 key。
const PROVIDER = "binance-account";
const MAX_TRADE_SOURCE_RECORDS = 1_000;

export interface BinanceTradeSourceRecord {
  symbol: string;
  direction: "long" | "short";
  source: Exclude<BinanceTradeSource, "mixed" | "unknown">;
  entryOrderId: number;
  openedAt: number;
  closedAt?: number;
}

interface StoredBinanceAccount extends BinanceAccountCreds {
  tradeSources?: BinanceTradeSourceRecord[];
}

function validTradeSource(value: unknown): value is BinanceTradeSourceRecord["source"] {
  return value === "volume_top20" || value === "gainers_top10" || value === "losers_top10" || value === "manual";
}

function parseStoredAccount(key: string | undefined): StoredBinanceAccount | null {
  if (!key) return null;
  try {
    const parsed = JSON.parse(key) as Partial<StoredBinanceAccount>;
    if (!parsed.apiKey || !parsed.apiSecret) return null;
    const tradeSources = Array.isArray(parsed.tradeSources)
      ? parsed.tradeSources.filter((row): row is BinanceTradeSourceRecord => Boolean(
        row && row.symbol && (row.direction === "long" || row.direction === "short") &&
        validTradeSource(row.source) && Number.isFinite(row.entryOrderId) && Number.isFinite(row.openedAt),
      ))
      : [];
    return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret, testnet: Boolean(parsed.testnet), tradeSources };
  } catch {
    return null;
  }
}

async function loadStoredAccount(): Promise<StoredBinanceAccount | null> {
  const cred = await getAiRuntime().credentials.read(PROVIDER);
  return cred?.type === "api_key" ? parseStoredAccount(cred.key) : null;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

async function loadCreds(): Promise<BinanceAccountCreds | null> {
  const stored = await loadStoredAccount();
  return stored ? { apiKey: stored.apiKey, apiSecret: stored.apiSecret, testnet: stored.testnet } : null;
}

function sourceMatchesDirection(record: BinanceTradeSourceRecord, direction: BinanceClosedPositionHistory["rows"][number]["direction"]): boolean {
  return direction === "unknown" || direction === "mixed" || direction === record.direction;
}

export function applyBinanceTradeSources(
  records: BinanceTradeSourceRecord[],
  history: BinanceClosedPositionHistory,
): { history: BinanceClosedPositionHistory; records: BinanceTradeSourceRecord[]; changed: boolean } {
  const nextRecords = records.map((record) => ({ ...record }));
  const rows = history.rows.map((row) => ({ ...row }));
  const used = new Map<string, number>();
  let changed = false;

  for (const record of nextRecords.sort((a, b) => a.openedAt - b.openedAt)) {
    const candidates = rows
      .filter((row) => row.symbol === record.symbol && sourceMatchesDirection(record, row.direction) && (used.get(row.id) ?? 0) < row.closeCount)
      .sort((a, b) => a.closedAt - b.closedAt);
    const matched = record.closedAt == null
      ? candidates.find((row) => row.closedAt >= record.openedAt)
      : candidates.find((row) => Math.abs(row.closedAt - record.closedAt!) <= 60_000);
    if (!matched) continue;
    used.set(matched.id, (used.get(matched.id) ?? 0) + 1);
    matched.source = matched.source === "unknown" || matched.source === record.source ? record.source : "mixed";
    if (record.closedAt == null) {
      record.closedAt = matched.closedAt;
      changed = true;
    }
  }
  return { history: { ...history, rows }, records: nextRecords, changed };
}

export function applyBinancePositionSources(
  records: BinanceTradeSourceRecord[],
  positions: BinancePositionRow[],
): BinancePositionRow[] {
  return positions.map((position) => {
    const source = records
      .filter((record) => record.closedAt == null && record.symbol === position.symbol && record.direction === position.side)
      .sort((a, b) => b.openedAt - a.openedAt)[0]?.source ?? "unknown";
    return { ...position, source };
  });
}

async function appendTradeSource(record: BinanceTradeSourceRecord): Promise<void> {
  await getAiRuntime().credentials.modify(PROVIDER, async (credential) => {
    if (!credential || credential.type !== "api_key") return credential;
    const stored = parseStoredAccount(credential.key);
    if (!stored) return credential;
    const tradeSources = [...(stored.tradeSources ?? []), record].slice(-MAX_TRADE_SOURCE_RECORDS);
    return { type: "api_key", key: JSON.stringify({ ...stored, tradeSources }) };
  });
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
    const previous = await loadStoredAccount();
    const tradeSources = previous?.apiKey === apiKey && previous.testnet === creds.testnet ? previous.tradeSources ?? [] : [];
    getAiRuntime().credentials.setApiKey(PROVIDER, JSON.stringify({ ...creds, tradeSources }));
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
    const stored = await loadStoredAccount();
    requireCreds(stored);
    return applyBinancePositionSources(stored.tradeSources ?? [], await binancePositions(stored));
  },

  async closedPositionHistory() {
    const stored = await loadStoredAccount();
    requireCreds(stored);
    const rawHistory = await binanceClosedPositionHistory(stored);
    let enriched = rawHistory;
    await getAiRuntime().credentials.modify(PROVIDER, async (credential) => {
      if (!credential || credential.type !== "api_key") return credential;
      const current = parseStoredAccount(credential.key);
      if (!current) return credential;
      const reconciled = applyBinanceTradeSources(current.tradeSources ?? [], rawHistory);
      enriched = reconciled.history;
      return reconciled.changed
        ? { type: "api_key", key: JSON.stringify({ ...current, tradeSources: reconciled.records }) }
        : credential;
    });
    return enriched;
  },

  async openOrders() {
    const creds = await loadCreds();
    requireCreds(creds);
    return binanceOpenOrders(creds);
  },

  async placeTestnetOrder(input) {
    const creds = await loadCreds();
    requireCreds(creds);
    const result = await binancePlaceTestnetOrder(creds, input);
    await appendTradeSource({
      symbol: input.symbol.toUpperCase(),
      direction: input.direction === "LONG" ? "long" : "short",
      source: input.source ?? "manual",
      entryOrderId: result.entryOrder.orderId,
      openedAt: result.entryOrder.updateTime || Date.now(),
    });
    return result;
  },

  async closeTestnetPosition(input) {
    const creds = await loadCreds();
    requireCreds(creds);
    return binanceCloseTestnetPosition(creds, input);
  },

  async closeAllTestnetPositions(input) {
    const creds = await loadCreds();
    requireCreds(creds);
    return binanceCloseAllTestnetPositions(creds, input);
  },

  async cancelTestnetOrder(input) {
    const creds = await loadCreds();
    requireCreds(creds);
    return binanceCancelTestnetOrder(creds, input);
  },
};
