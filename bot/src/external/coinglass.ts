// ============================================================================
// coinglass.ts — Lightweight Coinglass REST client.
// ----------------------------------------------------------------------------
// We pull four metrics that historically have the strongest signal for
// directional confluence on futures:
//
//   1. Funding rate          — crowded longs (very positive funding) tend to
//                              get squeezed → bearish bias. Extreme negative
//                              funding → bullish bias.
//   2. Open Interest 24h Δ   — OI rising with price = healthy continuation.
//                              OI falling = short-covering / weak trend.
//   3. Top trader L/S ratio  — extremes are contrarian (smart-money exits).
//   4. 24h liquidations      — liquidation imbalance shows recent forced flow.
//
// IMPORTANT: Coinglass's exact endpoint paths and JSON shapes change between
// API versions. Default URLs target v3 (open-api-v3.coinglass.com). If your
// subscription tier exposes different paths, override via env or by editing
// the `ENDPOINTS` map below. The integration is OPTIONAL — when the API key
// is missing, every fetch returns `null` and the scorer treats that as a
// neutral confluence (multiplier = 1.0).
//
// All responses are cached in-memory per (symbol, metric) for COINGLASS_CACHE_MS
// to stay well under the free-tier rate limits.
// ============================================================================

import axios, { AxiosError, type AxiosInstance } from "axios";
import { env } from "../shared/env.js";
import { logger } from "../shared/logger.js";
import { prisma } from "../shared/db.js";

export interface CoinglassMetrics {
  symbol: string;                  // base symbol (e.g. "BTC")
  fundingRate?: number;            // e.g. 0.0001 = 0.01%
  openInterestUsd?: number;
  oiChange24hPct?: number;         // -100..+inf
  longShortRatio?: number;         // top-trader ratio; >1 = longs dominant
  liqLong24hUsd?: number;          // longs liquidated in last 24h (USD)
  liqShort24hUsd?: number;
  capturedAt: Date;
}

interface CacheEntry { at: number; data: CoinglassMetrics; }

/**
 * Strip the USDT quote from a symbol to get the Coinglass-friendly base.
 *   "BTCUSDT"   → "BTC"
 *   "1000PEPEUSDT" → "1000PEPE"
 */
export function toBaseAsset(symbol: string): string {
  return symbol.replace(/USDT$|USDC$|BUSD$/i, "");
}

export class CoinglassClient {
  private readonly http: AxiosInstance;
  private readonly cache = new Map<string, CacheEntry>();

  constructor() {
    this.http = axios.create({
      baseURL: env.COINGLASS_BASE_URL,
      timeout: 8_000,
      headers: env.hasCoinglass ? { "CG-API-KEY": env.COINGLASS_API_KEY } : {},
    });
  }

  /** Returns null when no API key is configured (graceful degradation). */
  async getMetrics(symbol: string): Promise<CoinglassMetrics | null> {
    if (!env.hasCoinglass) return null;

    const base = toBaseAsset(symbol);
    const cached = this.cache.get(base);
    if (cached && Date.now() - cached.at < env.COINGLASS_CACHE_MS) return cached.data;

    const [funding, oi, ls, liq] = await Promise.allSettled([
      this.fetchFundingRate(base),
      this.fetchOpenInterest(base),
      this.fetchLongShortRatio(base),
      this.fetchLiquidations24h(base),
    ]);

    const metrics: CoinglassMetrics = {
      symbol: base,
      fundingRate: pick(funding),
      openInterestUsd: pickField(oi, "openInterestUsd"),
      oiChange24hPct: pickField(oi, "oiChange24hPct"),
      longShortRatio: pick(ls),
      liqLong24hUsd: pickField(liq, "long"),
      liqShort24hUsd: pickField(liq, "short"),
      capturedAt: new Date(),
    };

    // Persist a snapshot so the report page can correlate Coinglass state
    // with trade outcomes over time.
    try {
      await prisma.coinglassSnapshot.create({
        data: {
          symbol: base,
          fundingRate: metrics.fundingRate ?? null,
          openInterest: metrics.openInterestUsd ?? null,
          oiChange24h: metrics.oiChange24hPct ?? null,
          longShortRatio: metrics.longShortRatio ?? null,
          liqLong24h: metrics.liqLong24hUsd ?? null,
          liqShort24h: metrics.liqShort24hUsd ?? null,
          raw: JSON.stringify(metrics),
        },
      });
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "Failed to persist Coinglass snapshot");
    }

    this.cache.set(base, { at: Date.now(), data: metrics });
    return metrics;
  }

  // ----- per-endpoint fetchers --------------------------------------------
  // Each returns its own narrow shape. Wrap in try/catch so one outage
  // doesn't poison the others.

  private async fetchFundingRate(base: string): Promise<number | undefined> {
    try {
      const r = await this.http.get(`/api/futures/fundingRate/exchange-list?symbol=${base}`);
      // Try to extract Binance funding from the response. Coinglass shapes vary.
      const data = unwrap(r.data);
      const binance = findExchange(data, "Binance") ?? findExchange(data, "binance");
      if (binance && typeof binance.fundingRate === "number") return binance.fundingRate;
      if (binance && typeof binance.rate === "number") return binance.rate;
      // Fallback: average across exchanges
      const rates = collectNumbers(data, ["fundingRate", "rate"]);
      if (rates.length) return rates.reduce((s, v) => s + v, 0) / rates.length;
    } catch (e) { this.logSoft("fundingRate", e); }
    return undefined;
  }

  private async fetchOpenInterest(base: string): Promise<{ openInterestUsd?: number; oiChange24hPct?: number; } | undefined> {
    try {
      const r = await this.http.get(`/api/futures/openInterest/exchange-list?symbol=${base}`);
      const data = unwrap(r.data);
      const totals = aggregateField(data, ["openInterestUsd", "openInterest"]);
      const change = pickFirstNumber(data, ["h24Change", "change24h", "openInterestChangePercent24h"]);
      return { openInterestUsd: totals, oiChange24hPct: change };
    } catch (e) { this.logSoft("openInterest", e); }
    return undefined;
  }

  private async fetchLongShortRatio(base: string): Promise<number | undefined> {
    try {
      const r = await this.http.get(`/api/futures/longShort/topPositionRatio?symbol=${base}&exchangeName=Binance&interval=h1&limit=1`);
      const data = unwrap(r.data);
      const arr = Array.isArray(data) ? data : (data?.list ?? data?.data ?? []);
      const latest = arr.at?.(-1) ?? arr[0];
      if (latest) {
        if (typeof latest.longShortRatio === "number") return latest.longShortRatio;
        if (typeof latest.ratio === "number") return latest.ratio;
        if (typeof latest.longRate === "number" && typeof latest.shortRate === "number" && latest.shortRate > 0) {
          return latest.longRate / latest.shortRate;
        }
      }
    } catch (e) { this.logSoft("longShortRatio", e); }
    return undefined;
  }

  private async fetchLiquidations24h(base: string): Promise<{ long?: number; short?: number; } | undefined> {
    try {
      const r = await this.http.get(`/api/futures/liquidation/v2/exchange?symbol=${base}&timeType=h24`);
      const data = unwrap(r.data);
      const binance = findExchange(data, "Binance") ?? findExchange(data, "binance");
      const longUsd = binance?.longVolUsd ?? binance?.buyVolUsd ?? binance?.long;
      const shortUsd = binance?.shortVolUsd ?? binance?.sellVolUsd ?? binance?.short;
      return { long: numOrUndef(longUsd), short: numOrUndef(shortUsd) };
    } catch (e) { this.logSoft("liquidations", e); }
    return undefined;
  }

  private logSoft(endpoint: string, err: unknown): void {
    const ae = err as AxiosError;
    logger.warn(
      { endpoint, status: ae.response?.status, msg: ae.message },
      "Coinglass fetch failed (soft) — confluence will degrade for this metric"
    );
  }
}

// ----- shape-agnostic helpers --------------------------------------------
// Coinglass JSON shapes vary by tier + version, so we extract defensively.

function unwrap(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const obj = payload as Record<string, unknown>;
  if ("data" in obj) return obj.data;
  return obj;
}

function findExchange(data: unknown, name: string): Record<string, unknown> | undefined {
  if (Array.isArray(data)) {
    return data.find((d: Record<string, unknown>) => String(d.exchangeName ?? d.exchange ?? "").toLowerCase() === name.toLowerCase());
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const list = (obj.list ?? obj.exchanges ?? obj.exchangeList) as unknown;
    if (Array.isArray(list)) return findExchange(list, name);
  }
  return undefined;
}

function collectNumbers(data: unknown, keys: string[]): number[] {
  const out: number[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      for (const k of keys) {
        const val = (v as Record<string, unknown>)[k];
        if (typeof val === "number" && Number.isFinite(val)) out.push(val);
      }
      Object.values(v as Record<string, unknown>).forEach(visit);
    }
  };
  visit(data);
  return out;
}

function aggregateField(data: unknown, keys: string[]): number | undefined {
  const nums = collectNumbers(data, keys);
  if (!nums.length) return undefined;
  return nums.reduce((s, v) => s + v, 0);
}

function pickFirstNumber(data: unknown, keys: string[]): number | undefined {
  const visit = (v: unknown): number | undefined => {
    if (Array.isArray(v)) { for (const x of v) { const r = visit(x); if (r !== undefined) return r; } return; }
    if (v && typeof v === "object") {
      for (const k of keys) {
        const val = (v as Record<string, unknown>)[k];
        if (typeof val === "number" && Number.isFinite(val)) return val;
      }
      for (const x of Object.values(v as Record<string, unknown>)) {
        const r = visit(x); if (r !== undefined) return r;
      }
    }
  };
  return visit(data);
}

function pick<T>(r: PromiseSettledResult<T>): T | undefined {
  return r.status === "fulfilled" ? r.value : undefined;
}

function pickField<T extends Record<string, unknown>, K extends keyof T>(
  r: PromiseSettledResult<T | undefined>, key: K
): T[K] | undefined {
  return r.status === "fulfilled" && r.value ? r.value[key] : undefined;
}

function numOrUndef(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
