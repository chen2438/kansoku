import { binanceProvider } from "../src/services/marketdata/binance.js";

const symbols = process.argv.slice(2).map((symbol) => symbol.toUpperCase());
const targets = symbols.length ? symbols : ["BTCUSDT", "NVDAUSDT", "XAUUSDT"];

for (const symbol of targets) {
  const [quotes, bars, derivatives] = await Promise.all([
    binanceProvider.getQuotes([symbol]),
    binanceProvider.getKline(symbol, "5m", 3),
    binanceProvider.getDerivativesSnapshot?.(symbol),
  ]);
  console.log(JSON.stringify({
    symbol,
    quote: quotes[0] ?? null,
    bars: bars.length,
    contractType: derivatives?.instrument.contractType,
    underlyingType: derivatives?.instrument.underlyingType,
    markPrice: derivatives?.mark?.markPrice,
    openInterest: derivatives?.openInterest?.contracts,
    fundingRate: derivatives?.mark?.lastFundingRate,
    depthBids: derivatives?.depth?.bids.length ?? 0,
    recentTrades: derivatives?.recentTrades.length ?? 0,
    capturedLiquidations: derivatives?.liquidations.length ?? 0,
  }));
}

process.exit(0);
