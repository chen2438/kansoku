import { ClientError } from "../../errors.js";
import { longbridgeProvider } from "./longbridge.js";
import { binanceProvider } from "./binance.js";
import type { MarketDataProvider } from "./types.js";
import { isBinanceSymbol } from "../symbol.utils.js";

const providers: Record<string, MarketDataProvider> = {
  longbridge: longbridgeProvider,
  "binance-usdm": binanceProvider,
};

export { isBinanceSymbol } from "../symbol.utils.js";

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
