export const fmt = (x: number, d = 2) => x.toFixed(d);

export const signed = (x: number, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d);

export const money = (x: number, d = 2) => `$${x.toFixed(d)}`;

export const upDown = (x: number) => (x >= 0 ? "up" : "down");

// Binance 品种（无交易所后缀，如 XRPUSDT）扩位；美股（NVDA.US 等）保持 2 位。
export const isCryptoSymbol = (symbol: string | null | undefined): boolean =>
  typeof symbol === "string" && symbol.length > 0 && !symbol.includes(".");

// 价格小数位随量级变化。
// - 美股：$1 以上保持 2 位（tick 0.01），$1 以下才细化。
// - Binance（crypto=true）：所有品种按 ~5 位有效数字统一扩位——XRP 1.09→4 位、
//   ETH 1812→2 位、WLD 0.41→5 位、SXT 0.0093→7 位，避免入场/止损/目标被压成同一个数。
export function priceDecimals(price: number, crypto = false): number {
  const abs = Math.abs(price);
  if (!Number.isFinite(abs) || abs === 0) return crypto ? 4 : 2;
  if (crypto) {
    const exp = Math.floor(Math.log10(abs));
    return Math.min(8, Math.max(2, 4 - exp));
  }
  if (abs >= 1) return 2;
  if (abs >= 0.1) return 4;
  if (abs >= 0.01) return 5;
  if (abs >= 0.001) return 6;
  return 8;
}

// 价格专用格式化：不传 decimals 时按自身量级自动取位；
// 同一标的的多个价格应传入统一的 decimals（用现价算一次）保证一致。
export const priceStr = (x: number, decimals = priceDecimals(x)) => x.toFixed(decimals);

export const priceMoney = (x: number, decimals = priceDecimals(x)) => `$${priceStr(x, decimals)}`;
