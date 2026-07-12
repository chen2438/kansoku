export const fmt = (x: number, d = 2) => x.toFixed(d);

export const signed = (x: number, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d);

export const money = (x: number, d = 2) => `$${x.toFixed(d)}`;

export const upDown = (x: number) => (x >= 0 ? "up" : "down");

// 价格小数位随量级变化：美股/BTC/ETH 等 $1 以上保持 2 位不变，
// Binance 低价币（WLD 0.41、DOGE 0.16 等）自动给更细的精度，
// 否则入场/止损/目标会被压成同一个 $0.40 分不出来。
export function priceDecimals(price: number): number {
  const abs = Math.abs(price);
  if (!Number.isFinite(abs) || abs === 0) return 2;
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
