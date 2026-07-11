import type { CockpitPosition, RelativeVolume } from "../../../shared/types.js";
import { buildCockpitPosition } from "../services/cockpit/position.js";
import { entryPlanFromDoc, latestIntradayDoc, type EntryPlan } from "../services/cockpit/entryPlan.js";
import { getLongbridgeStream } from "../services/marketdata/longbridgeStream.js";
import { getProvider } from "../services/marketdata/registry.js";
import type { RawPosition } from "../services/marketdata/types.js";
import { computeRelativeVolume } from "../services/relvol.js";
import { createEmitter, emitData, emitStatus, replay } from "./emitter.js";

const SLOW_REFRESH_MS = 60_000;
const PUSH_THROTTLE_MS = 1_000;
const RELVOL_BARS = 500;
const isBinanceSymbol = (symbol: string): boolean => !symbol.includes(".") && /^[A-Z0-9]+USDT$/i.test(symbol);

export interface PositionPayload {
  position: CockpitPosition | null;
  relvol: RelativeVolume | null;
}

interface State {
  emitter: ReturnType<typeof createEmitter>;
  positions: RawPosition[];
  plan: EntryPlan | null;
  relvol: RelativeVolume | null;
  quoteUnsub: (() => void) | null;
  slowTimer: ReturnType<typeof setInterval> | null;
  pushTimer: ReturnType<typeof setTimeout> | null;
  refreshing: Promise<void> | null;
  last: number | null;
}

const states = new Map<string, State>();

/** Pure: cached position snapshot × a live quote → the channel payload. */
export function buildPositionPayload(
  positions: RawPosition[],
  symbol: string,
  last: number,
  plan: EntryPlan | null,
  relvol: RelativeVolume | null,
): PositionPayload {
  return { position: buildCockpitPosition(positions, symbol, last, plan), relvol };
}

function pushLatest(state: State, symbol: string): void {
  if (state.last !== null) {
    emitData(state.emitter, buildPositionPayload(state.positions, symbol, state.last, state.plan, state.relvol));
    return;
  }
  const quote = getLongbridgeStream().getSnapshot(symbol);
  if (!quote) return;
  emitData(state.emitter, buildPositionPayload(state.positions, symbol, quote.last, state.plan, state.relvol));
}

function schedulePush(state: State, symbol: string): void {
  if (state.pushTimer) return;
  state.pushTimer = setTimeout(() => {
    state.pushTimer = null;
    pushLatest(state, symbol);
  }, PUSH_THROTTLE_MS);
}

async function refresh(symbol: string, state: State): Promise<void> {
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    try {
      const provider = getProvider(symbol);
      const [positions, doc, bars, quotes] = await Promise.all([
        provider.getPositions?.() ?? Promise.resolve([]),
        latestIntradayDoc(symbol),
        provider.getKline(symbol, "15m", RELVOL_BARS).catch(() => null),
        isBinanceSymbol(symbol) ? provider.getQuotes([symbol]) : Promise.resolve([]),
      ]);
      state.positions = positions;
      state.plan = entryPlanFromDoc(doc);
      state.relvol = bars ? computeRelativeVolume(bars) : state.relvol;
      state.last = quotes.length ? Number(quotes[0].last) : state.last;
      emitStatus(state.emitter, false);
      pushLatest(state, symbol);
    } catch (err) {
      emitStatus(state.emitter, true, err instanceof Error ? err.message : String(err));
    }
  })().finally(() => {
    state.refreshing = null;
  });
  return state.refreshing;
}

export function subscribePosition(symbol: string, push: (envelope: string) => void): () => void {
  let state = states.get(symbol);
  const fresh = !state;
  if (!state) {
    state = {
      emitter: createEmitter(),
      positions: [],
      plan: null,
      relvol: null,
      quoteUnsub: null,
      slowTimer: null,
      pushTimer: null,
      refreshing: null,
      last: null,
    };
    states.set(symbol, state);
  }
  state.emitter.listeners.add(push);

  if (fresh) {
    const retainPromise = isBinanceSymbol(symbol)
      ? Promise.resolve()
      : getLongbridgeStream().retain([symbol]).catch((err) => console.warn("[ws-position] retain failed", err));
    if (!isBinanceSymbol(symbol)) {
      state.quoteUnsub = getLongbridgeStream().onUpdate((cell) => {
        if (cell.symbol === symbol) schedulePush(state as State, symbol);
      });
    }
    state.slowTimer = setInterval(() => void refresh(symbol, state as State), SLOW_REFRESH_MS);
    const refreshPromise = refresh(symbol, state);
    // retain() and the initial refresh() race independently; whichever seeds the quote
    // snapshot last leaves `pushLatest` a no-op inside the other, so re-push once both settle.
    void Promise.all([retainPromise, refreshPromise]).then(() => pushLatest(state as State, symbol));
  } else {
    replay(state.emitter, push);
  }

  return () => {
    const s = states.get(symbol);
    if (!s) return;
    s.emitter.listeners.delete(push);
    if (s.emitter.listeners.size === 0) {
      s.quoteUnsub?.();
      if (s.slowTimer) clearInterval(s.slowTimer);
      if (s.pushTimer) clearTimeout(s.pushTimer);
      states.delete(symbol);
      if (!isBinanceSymbol(symbol)) void getLongbridgeStream().release([symbol]).catch(() => {});
    }
  };
}
