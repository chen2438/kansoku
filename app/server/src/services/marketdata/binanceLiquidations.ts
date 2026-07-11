import WebSocket from "ws";

interface ForceOrderEvent {
  o?: { s?: string; S?: string; p?: string; ap?: string; q?: string; X?: string; T?: number };
}

export interface BinanceLiquidation {
  side: string;
  price: number;
  averagePrice: number;
  quantity: number;
  status: string;
  time: string;
}

const MAX_PER_SYMBOL = 100;
const RECONNECT_MS = 5_000;
const rows = new Map<string, BinanceLiquidation[]>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let startedAt: string | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
  reconnectTimer.unref?.();
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const base = process.env.BINANCE_FUTURES_WS_URL ?? "wss://fstream.binance.com/ws";
  socket = new WebSocket(`${base.replace(/\/$/, "")}/!forceOrder@arr`);
  socket.on("open", () => {
    startedAt ??= new Date().toISOString();
  });
  socket.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString()) as ForceOrderEvent | ForceOrderEvent[];
      for (const event of Array.isArray(payload) ? payload : [payload]) {
        const order = event.o;
        if (!order?.s || !order.T) continue;
        const symbol = order.s.toUpperCase();
        const list = rows.get(symbol) ?? [];
        list.push({
          side: order.S ?? "",
          price: Number(order.p),
          averagePrice: Number(order.ap),
          quantity: Number(order.q),
          status: order.X ?? "",
          time: new Date(order.T).toISOString(),
        });
        if (list.length > MAX_PER_SYMBOL) list.splice(0, list.length - MAX_PER_SYMBOL);
        rows.set(symbol, list);
      }
    } catch {
      // Ignore malformed exchange messages and keep the stream alive.
    }
  });
  socket.on("close", scheduleReconnect);
  socket.on("error", () => socket?.close());
}

export function getLiquidationSnapshot(symbol: string): {
  rows: BinanceLiquidation[];
  coverageStartedAt: string | null;
} {
  connect();
  return { rows: [...(rows.get(symbol.toUpperCase()) ?? [])], coverageStartedAt: startedAt };
}
