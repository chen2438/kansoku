import { describe, expect, it } from "vitest";
import { isCryptoSymbol, priceDecimals, priceMoney, priceStr } from "./format";

describe("priceDecimals", () => {
  it("keeps 2 decimals for $1+ (equities / BTC / ETH unchanged)", () => {
    expect(priceDecimals(187.42)).toBe(2);
    expect(priceDecimals(1)).toBe(2);
    expect(priceDecimals(64231.5)).toBe(2);
  });

  it("gives finer precision to sub-$1 Binance tokens", () => {
    expect(priceDecimals(0.41)).toBe(4); // WLDUSDT
    expect(priceDecimals(0.16)).toBe(4); // DOGE
    expect(priceDecimals(0.05)).toBe(5);
    expect(priceDecimals(0.004)).toBe(6);
    expect(priceDecimals(0.00001234)).toBe(8);
  });

  it("falls back to 2 decimals for zero / non-finite", () => {
    expect(priceDecimals(0)).toBe(2);
    expect(priceDecimals(Number.NaN)).toBe(2);
    expect(priceDecimals(Number.POSITIVE_INFINITY)).toBe(2);
  });

  it("crypto mode expands $1+ tokens too (~5 significant figures)", () => {
    expect(priceDecimals(1.09, true)).toBe(4); // XRPUSDT — the reported bug
    expect(priceDecimals(1812.56, true)).toBe(2); // ETHUSDT
    expect(priceDecimals(150, true)).toBe(2); // SOLUSDT
    expect(priceDecimals(64231.5, true)).toBe(2); // BTCUSDT
    expect(priceDecimals(0.41, true)).toBe(5); // WLD
    expect(priceDecimals(0.009281, true)).toBe(7); // SXT
  });

  it("XRP levels are distinguishable in crypto mode", () => {
    const d = priceDecimals(1.09, true);
    expect(priceStr(1.1, d)).toBe("1.1000");
    expect(priceStr(1.0965, d)).toBe("1.0965");
    expect(priceStr(1.0918, d)).toBe("1.0918");
  });
});

describe("isCryptoSymbol", () => {
  it("treats dot-less tickers as Binance crypto", () => {
    expect(isCryptoSymbol("XRPUSDT")).toBe(true);
    expect(isCryptoSymbol("BTCUSDT")).toBe(true);
    expect(isCryptoSymbol("NVDA.US")).toBe(false);
    expect(isCryptoSymbol("700.HK")).toBe(false);
    expect(isCryptoSymbol("")).toBe(false);
    expect(isCryptoSymbol(null)).toBe(false);
  });
});

describe("priceStr", () => {
  it("no longer collapses a low-priced entry/stop/target into one number", () => {
    // The bug: entry 0.4039, stop 0.4000, target 0.4174 all rendered as $0.40.
    expect(priceStr(0.4039)).toBe("0.4039");
    expect(priceStr(0.4)).toBe("0.4000");
    expect(priceStr(0.4174)).toBe("0.4174");
  });

  it("honours an explicit per-symbol decimals for consistency", () => {
    // All levels of one symbol should share the decimals derived from its last price.
    const d = priceDecimals(0.41);
    expect(priceStr(0.4, d)).toBe("0.4000");
    expect(priceStr(0.42, d)).toBe("0.4200");
  });

  it("leaves $1+ prices at 2 decimals", () => {
    expect(priceStr(187.4)).toBe("187.40");
  });
});

describe("priceMoney", () => {
  it("prefixes $ and uses magnitude-aware decimals", () => {
    expect(priceMoney(0.41)).toBe("$0.4100");
    expect(priceMoney(187.42)).toBe("$187.42");
  });
});
