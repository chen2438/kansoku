import { ClientError } from "../../errors.js";
import { longbridgeProvider } from "./longbridge.js";
import { binanceProvider } from "./binance.js";
import type { MarketDataProvider } from "./types.js";

const providers: Record<string, MarketDataProvider> = {
  longbridge: longbridgeProvider,
  "binance-usdm": binanceProvider,
};

export function isBinanceSymbol(symbol: string): boolean {
  return !symbol.includes(".") && /^[A-Z0-9]+USDT$/i.test(symbol);
}

export function getProvider(symbol?: string): MarketDataProvider {
  if (symbol && isBinanceSymbol(symbol)) return binanceProvider;
  const name = process.env.MARKET_PROVIDER || "longbridge";
  const provider = providers[name];
  if (!provider) {
    throw new ClientError(
      `unknown MARKET_PROVIDER: ${name}`,
      `available providers: ${Object.keys(providers).join(", ")}`,
    );
  }
  return provider;
}

export function listProviders(): string[] {
  return Object.keys(providers);
}
