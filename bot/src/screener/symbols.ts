// ============================================================================
// symbols.ts — Resolve the active watchlist.
// ----------------------------------------------------------------------------
// Priority:
//   1. BotConfig.watchlist (DB) — if non-empty
//   2. env.SYMBOLS              — fallback
// ============================================================================

import { env } from "../shared/env.js";
import type { BotConfig } from "@prisma/client";
import type { Ticker24hr } from "../execution/binanceClient.js";

export function resolveWatchlist(cfg: BotConfig): string[] {
  try {
    const parsed = JSON.parse(cfg.watchlist);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return dedupe(parsed.map((s: unknown) => String(s).trim().toUpperCase()).filter(Boolean));
    }
  } catch {
    // fall through
  }
  // Backward compat: if BotConfig.symbol is set but watchlist isn't, use it +
  // env symbols combined.
  const fromEnv = env.symbolList;
  const fromCfg = cfg.symbol ? [cfg.symbol.toUpperCase()] : [];
  const merged = dedupe([...fromCfg, ...fromEnv]);
  return merged.length ? merged : ["BTCUSDT"];
}

export function resolveExchangeUniverse(
  filters: Map<string, Record<string, unknown>>,
  tickers24h: Ticker24hr[] = []
): string[] {
  const tradableSymbols = new Set(Array.from(filters.values())
    .filter((s) => {
      const symbol = String(s.symbol ?? "");
      const quoteAsset = String(s.quoteAsset ?? "");
      const contractType = String(s.contractType ?? "");
      const status = String(s.status ?? "");
      return (
        symbol.endsWith("USDT") &&
        isStandardUsdtSymbol(symbol) &&
        quoteAsset === "USDT" &&
        contractType === "PERPETUAL" &&
        status === "TRADING"
      );
    })
    .map((s) => String(s.symbol).toUpperCase()));

  const byVolume = tickers24h
    .map((ticker) => ({
      symbol: String(ticker.symbol ?? "").toUpperCase(),
      quoteVolume: Number(ticker.quoteVolume ?? 0),
    }))
    .filter((ticker) => tradableSymbols.has(ticker.symbol) && Number.isFinite(ticker.quoteVolume))
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const liquidSymbols = byVolume
    .filter((ticker) => ticker.quoteVolume >= env.MIN_24H_QUOTE_VOLUME)
    .map((ticker) => ticker.symbol);

  const fallbackByVolume = byVolume.map((ticker) => ticker.symbol);
  const fallbackAlphabetical = Array.from(tradableSymbols).sort();

  const selected = liquidSymbols.length > 0
    ? liquidSymbols
    : fallbackByVolume.length > 0
    ? fallbackByVolume
    : fallbackAlphabetical;

  return dedupe(selected).slice(0, env.MAX_SCREENER_SYMBOLS);
}

function dedupe<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }

function isStandardUsdtSymbol(symbol: string): boolean {
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
  const base = symbol.slice(0, -"USDT".length);
  return base.length >= 3;
}
