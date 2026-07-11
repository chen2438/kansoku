import { binanceProvider } from "../../packages/core/src/services/marketdata/binance.js";

for (const symbol of process.argv.slice(2).length ? process.argv.slice(2) : ["BTCUSDT", "NVDAUSDT", "XAUUSDT"]) {
  const [quotes, bars, data] = await Promise.all([binanceProvider.getQuotes([symbol]), binanceProvider.getKline(symbol, "5m", 3), binanceProvider.getDerivativesSnapshot!(symbol)]);
  console.log(JSON.stringify({ symbol, quote: quotes[0], bars: bars.length, contractType: data.instrument.contractType, underlyingType: data.instrument.underlyingType, markPrice: data.mark?.markPrice, openInterest: data.openInterest?.contracts, fundingRate: data.mark?.lastFundingRate, depthBids: data.depth?.bids.length, recentTrades: data.recentTrades.length }));
}
process.exit(0);
