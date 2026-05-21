// ============================================================================
// symbols.ts — Resolve the active watchlist.
// ----------------------------------------------------------------------------
// Priority:
//   1. BotConfig.watchlist (DB) — if non-empty
//   2. env.SYMBOLS              — fallback
// ============================================================================

import { env } from "../shared/env.js";
import type { BotConfig } from "@prisma/client";

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

function dedupe<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }
