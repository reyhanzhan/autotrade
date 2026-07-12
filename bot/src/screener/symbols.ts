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
      return withoutBlacklisted(dedupe(parsed.map((s: unknown) => String(s).trim().toUpperCase()).filter(Boolean)));
    }
  } catch {
    // fall through
  }
  // Backward compat: if BotConfig.symbol is set but watchlist isn't, use it +
  // env symbols combined.
  const fromEnv = env.symbolList;
  const fromCfg = cfg.symbol ? [cfg.symbol.toUpperCase()] : [];
  const merged = dedupe([...fromCfg, ...fromEnv]);
  const filtered = withoutBlacklisted(merged);
  return filtered.length ? filtered : ["BTCUSDT"];
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

  return withoutBlacklisted(dedupe(selected)).slice(0, env.MAX_SCREENER_SYMBOLS);
}

function dedupe<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }

function withoutBlacklisted(symbols: string[]): string[] {
  if (env.symbolBlacklist.size === 0) return symbols;
  return symbols.filter((symbol) => !env.symbolBlacklist.has(symbol));
}

function isStandardUsdtSymbol(symbol: string): boolean {
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
  const base = symbol.slice(0, -"USDT".length);
  return base.length >= 3;
}

import { prisma } from "../shared/db.js";

/** 
 * Returns a set of symbols that should be dynamically blacklisted for 14 days
 * based on poor historical performance (Win Rate < 30% or >= 3 consecutive losses).
 */
export async function getDynamicBlacklist(): Promise<Set<string>> {
  const dynamicBlacklist = new Set<string>();
  try {
    const trades = await prisma.trade.findMany({
      where: {
        closedAt: { not: null },
      },
      orderBy: { closedAt: 'desc' }
    });
    
    // Group trades by symbol
    const tradesBySymbol = new Map<string, typeof trades>();
    for (const t of trades) {
      const arr = tradesBySymbol.get(t.symbol) || [];
      arr.push(t);
      tradesBySymbol.set(t.symbol, arr);
    }
    
    const cutoff14Days = Date.now() - 14 * 24 * 60 * 60 * 1000;
    
    for (const [symbol, symTrades] of tradesBySymbol.entries()) {
      if (symTrades.length === 0) continue;
      
      const lastTradeTime = symTrades[0]?.closedAt?.getTime() ?? 0;
      if (lastTradeTime < cutoff14Days) continue; // 14 days have passed
      
      let consecutiveLosses = 0;
      for (const t of symTrades) {
        if (t.pnl && t.pnl < 0) consecutiveLosses++;
        else break;
      }
      
      const minTradesForWr = 5;
      let isBlacklisted = false;
      
      if (consecutiveLosses >= 3) {
        isBlacklisted = true;
      } else if (symTrades.length >= minTradesForWr) {
        let wins = 0;
        for (const t of symTrades) {
          if (t.pnl && t.pnl > 0) wins++;
        }
        const wr = wins / symTrades.length;
        if (wr < 0.3) isBlacklisted = true;
      }
      
      if (isBlacklisted) dynamicBlacklist.add(symbol);
    }
  } catch (err) {
    // Ignore db error
  }
  return dynamicBlacklist;
}
