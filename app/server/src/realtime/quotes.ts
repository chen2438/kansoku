import type { QuoteCell, QuoteSnapshot } from "../../../shared/types.js";
import { getLongbridgeStream } from "../services/marketdata/longbridgeStream.js";
import type { ExtendedQuote, RawQuote } from "../services/marketdata/types.js";
import { getProvider } from "../services/marketdata/registry.js";
import { classifySession } from "../services/session.js";

export type { RawQuote } from "../services/marketdata/types.js";

const EXTENDED_FRESH_MS = 15 * 60_000;
const isBinanceSymbol = (symbol: string): boolean => !symbol.includes(".") && /^[A-Z0-9]+USDT$/i.test(symbol);

const SESSION_LABEL: Record<string, string> = {
  pre: "盘前",
  post: "盘后",
  overnight: "隔夜",
};

export function normalizeQuote(q: RawQuote, nowMs: number): QuoteCell {
  const regularLast = Number(q.last);
  const regularPct = Number(q.change_percentage);
  if (isBinanceSymbol(q.symbol)) {
    return { symbol: q.symbol, session: "24h", last: regularLast, pct: regularPct, regularLast, regularPct };
  }
  const clock = classifySession(Math.floor(nowMs / 1000));
  if (clock === "regular") {
    return { symbol: q.symbol, session: "日盘", last: regularLast, pct: regularPct, regularLast, regularPct };
  }
  const label = SESSION_LABEL[clock];
  const preferred: ExtendedQuote | undefined =
    clock === "pre" ? q.pre_market : clock === "post" ? q.post_market : q.overnight;
  if (preferred?.last && preferred.prev_close && preferred.timestamp) {
    const ts = Date.parse(preferred.timestamp);
    if (nowMs - ts <= EXTENDED_FRESH_MS) {
      const last = Number(preferred.last);
      const prev = Number(preferred.prev_close);
      return {
        symbol: q.symbol,
        session: label ?? "日盘",
        last,
        pct: prev ? (last / prev - 1) * 100 : 0,
        regularLast,
        regularPct,
      };
    }
  }
  return { symbol: q.symbol, session: "日盘", last: regularLast, pct: regularPct, regularLast, regularPct };
}

const SYMBOLS_TTL_MS = 600_000;
const COALESCE_MS = 250;

let baseSymbols: string[] = [];
let baseFetchedAt = 0;
let baseRefreshInFlight: Promise<void> | null = null;

async function refreshBaseSymbols(): Promise<void> {
  if (Date.now() - baseFetchedAt < SYMBOLS_TTL_MS && baseSymbols.length) return;
  if (baseRefreshInFlight) return baseRefreshInFlight;
  baseRefreshInFlight = (async () => {
    const provider = getProvider();
    const set = new Set<string>();
    const [watchlist, positions] = await Promise.allSettled([
      provider.getWatchlistSymbols?.() ?? Promise.resolve([]),
      provider.getPositions?.() ?? Promise.resolve([]),
    ]);
    if (watchlist.status === "fulfilled") {
      for (const s of watchlist.value) set.add(s);
    }
    if (positions.status === "fulfilled") {
      for (const p of positions.value) set.add(p.symbol);
    }
    if (set.size) {
      const next = [...set];
      const dropped = baseSymbols.filter((s) => !set.has(s));
      const added = next.filter((s) => !baseSymbols.includes(s));
      baseSymbols = next;
      baseFetchedAt = Date.now();
      if (added.length) await getLongbridgeStream().retain(added).catch(() => {});
      if (dropped.length) await getLongbridgeStream().release(dropped).catch(() => {});
    }
  })().finally(() => {
    baseRefreshInFlight = null;
  });
  return baseRefreshInFlight;
}

const listeners = new Set<(env: string) => void>();
const dedup = new Set<string>();
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
let listenerHandle: (() => void) | null = null;
let baseRefreshTimer: ReturnType<typeof setInterval> | null = null;
let baseRetained = false;
let degraded = false;
let lastEnvelope: string | null = null;
const binanceQuotes = new Map<string, QuoteCell>();
let binanceTimer: ReturnType<typeof setInterval> | null = null;

function emit(env: string): void {
  for (const l of listeners) l(env);
}

function buildSnapshot(): QuoteSnapshot {
  const stream = getLongbridgeStream();
  const seen = new Set<string>();
  const quotes: QuoteCell[] = [];
  for (const s of baseSymbols) {
    if (seen.has(s)) continue;
    seen.add(s);
    const cell = stream.getSnapshot(s);
    if (cell) quotes.push(cell);
  }
  for (const s of extras.keys()) {
    if (seen.has(s)) continue;
    seen.add(s);
    const cell = isBinanceSymbol(s) ? binanceQuotes.get(s) : stream.getSnapshot(s);
    if (cell) quotes.push(cell);
  }
  return { ts: Date.now(), quotes };
}

async function refreshBinanceQuotes(): Promise<void> {
  const symbols = [...extras.keys()].filter(isBinanceSymbol);
  if (!symbols.length) return;
  const rows = await Promise.all(symbols.map(async (symbol) => {
    const [quote] = await getProvider(symbol).getQuotes([symbol]);
    return quote ? normalizeQuote(quote, Date.now()) : null;
  }));
  for (const row of rows) if (row) binanceQuotes.set(row.symbol, row);
  flushCoalesced();
}

function ensureBinancePolling(): void {
  if (![...extras.keys()].some(isBinanceSymbol)) return;
  void refreshBinanceQuotes().catch(() => {});
  if (!binanceTimer) binanceTimer = setInterval(() => void refreshBinanceQuotes().catch(() => {}), 5_000);
}

function flushCoalesced(): void {
  coalesceTimer = null;
  dedup.clear();
  const snap = buildSnapshot();
  const env = JSON.stringify({ type: "data", data: snap });
  if (env === lastEnvelope) return;
  lastEnvelope = env;
  emit(env);
}

function scheduleFlush(symbol: string): void {
  if (dedup.has(symbol) && coalesceTimer) return;
  dedup.add(symbol);
  if (coalesceTimer) return;
  coalesceTimer = setTimeout(flushCoalesced, COALESCE_MS);
}

function ensureListener(): void {
  if (listenerHandle) return;
  listenerHandle = getLongbridgeStream().onUpdate((cell) => {
    scheduleFlush(cell.symbol);
  });
}

async function ensureBase(): Promise<void> {
  await refreshBaseSymbols();
  if (!baseRetained && baseSymbols.length) {
    await getLongbridgeStream().retain(baseSymbols).catch((err) => {
      degraded = true;
      console.warn("[longbridge-stream] base retain failed:", err instanceof Error ? err.message : err);
    });
    baseRetained = true;
  }
}

function startBaseRefreshTimer(): void {
  if (baseRefreshTimer) return;
  baseRefreshTimer = setInterval(() => {
    void refreshBaseSymbols().catch(() => {});
  }, SYMBOLS_TTL_MS);
}

function stopIfIdle(): void {
  if (listeners.size > 0) return;
  if (coalesceTimer) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
  if (baseRefreshTimer) {
    clearInterval(baseRefreshTimer);
    baseRefreshTimer = null;
  }
  if (listenerHandle) {
    listenerHandle();
    listenerHandle = null;
  }
  lastEnvelope = null;
  if (binanceTimer) {
    clearInterval(binanceTimer);
    binanceTimer = null;
  }
  binanceQuotes.clear();
  if (baseRetained && baseSymbols.length) {
    void getLongbridgeStream().release(baseSymbols).catch(() => {});
    baseRetained = false;
  }
}

const extras = new Map<string, number>();

function addExtras(symbols: string[]): string[] {
  const fresh: string[] = [];
  for (const s of symbols) {
    const n = (extras.get(s) ?? 0) + 1;
    extras.set(s, n);
    if (n === 1) fresh.push(s);
  }
  return fresh;
}

function removeExtras(symbols: string[]): string[] {
  const drop: string[] = [];
  for (const s of symbols) {
    const n = (extras.get(s) ?? 0) - 1;
    if (n <= 0) {
      extras.delete(s);
      drop.push(s);
    } else {
      extras.set(s, n);
    }
  }
  return drop;
}

export function subscribeQuotes(push: (envelope: string) => void, extraSymbols: string[] = []): () => void {
  const cleaned = extraSymbols.filter((s) => /^[\w.]+$/.test(s));
  const fresh = addExtras(cleaned);

  listeners.add(push);
  ensureListener();
  startBaseRefreshTimer();

  const longbridgeFresh = fresh.filter((s) => !isBinanceSymbol(s));
  if (longbridgeFresh.length) {
    void getLongbridgeStream()
      .retain(longbridgeFresh)
      .catch((err) => console.warn("[longbridge-stream] retain extras failed", err));
  }
  ensureBinancePolling();
  void ensureBase().then(() => {
    if (lastEnvelope) push(lastEnvelope);
    else scheduleFlush(cleaned[0] ?? baseSymbols[0] ?? "");
  });
  if (degraded) push(JSON.stringify({ type: "status", degraded: true }));
  if (lastEnvelope) push(lastEnvelope);

  return () => {
    listeners.delete(push);
    const drop = removeExtras(cleaned);
    const longbridgeDrop = drop.filter((s) => !isBinanceSymbol(s));
    if (longbridgeDrop.length) void getLongbridgeStream().release(longbridgeDrop).catch(() => {});
    for (const symbol of drop.filter(isBinanceSymbol)) binanceQuotes.delete(symbol);
    if (binanceTimer && ![...extras.keys()].some(isBinanceSymbol)) {
      clearInterval(binanceTimer);
      binanceTimer = null;
    }
    stopIfIdle();
  };
}
