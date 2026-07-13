export function normalizeSymbol(raw: string): string | null {
  let sym = raw.trim().toUpperCase();
  if (!sym) return null;
  if (/^[A-Z0-9]+USDT$/.test(sym)) return sym;
  if (!sym.includes(".")) sym += ".US";
  return /^[A-Z0-9.]+$/.test(sym) ? sym : null;
}
