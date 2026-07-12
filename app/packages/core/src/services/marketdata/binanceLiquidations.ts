interface ForceOrder { o?: { s?: string; S?: string; p?: string; ap?: string; q?: string; X?: string; T?: number } }
type Liquidation = BinanceDerivativesSnapshot["liquidations"][number];
import type { BinanceDerivativesSnapshot } from "./types.js";

const cache = new Map<string, Liquidation[]>();
let socket: WebSocket | null = null;
let startedAt: string | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const base = process.env.BINANCE_FUTURES_WS_URL ?? "wss://fstream.binance.com/ws";
  socket = new WebSocket(`${base.replace(/\/$/, "")}/!forceOrder@arr`);
  socket.addEventListener("open", () => { startedAt ??= new Date().toISOString(); });
  socket.addEventListener("message", (message) => {
    try {
      const parsed = JSON.parse(String(message.data)) as ForceOrder | ForceOrder[];
      for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
        const o = event.o;
        if (!o?.s || !o.T) continue;
        const rows = cache.get(o.s) ?? [];
        rows.push({ side: o.S ?? "", price: Number(o.p), averagePrice: Number(o.ap), quantity: Number(o.q), status: o.X ?? "", time: new Date(o.T).toISOString() });
        cache.set(o.s, rows.slice(-100));
      }
    } catch { /* ignore malformed exchange frames */ }
  });
  socket.addEventListener("close", () => {
    if (retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, 5_000);
    retry.unref?.();
  });
  socket.addEventListener("error", () => socket?.close());
}

export function getLiquidationSnapshot(symbol: string) {
  connect();
  return { rows: [...(cache.get(symbol.toUpperCase()) ?? [])], coverageStartedAt: startedAt };
}
