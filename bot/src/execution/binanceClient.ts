// ============================================================================
// binanceClient.ts — Signed REST client for Binance USDT-M Futures.
// ----------------------------------------------------------------------------
// Why hand-rolled instead of the official SDK:
//   - Total control over rate-limit accounting (we read X-MBX-USED-WEIGHT-1m
//     from the response header and back off proactively).
//   - Smaller dependency footprint on the VPS.
//   - Trivially swappable between testnet and mainnet via env.
//
// SECURITY:
//   - API key/secret are loaded once via `decryptSecret` from the BotConfig
//     row and kept ONLY in memory — never logged.
//   - Signing uses HMAC-SHA256(queryString, secret) per Binance spec.
//   - `recvWindow` defaults to 5000ms; we attach the local timestamp.
//
// RATE LIMITS (Futures):
//   - 2400 weight / minute. We refuse new requests once we hit 90% headroom.
//   - 1200 orders / minute. We track via local counter as a soft guard.
// ============================================================================

import axios, { AxiosError, type AxiosInstance, type AxiosResponse } from "axios";
import { createHmac } from "node:crypto";
import { BINANCE_ENDPOINTS } from "../shared/env.js";
import { logger } from "../shared/logger.js";

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface PlaceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity?: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  closePosition?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  newClientOrderId?: string;
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
}

export class BinanceFuturesClient {
  private readonly http: AxiosInstance;
  private usedWeight = 0;
  private weightResetAt = Date.now() + 60_000;
  private orderCount = 0;
  private orderResetAt = Date.now() + 60_000;

  private static readonly WEIGHT_CAP = 2400;
  private static readonly WEIGHT_HEADROOM = 0.9;       // refuse at 90% used
  private static readonly ORDER_CAP_PER_MIN = 1200;

  constructor(private readonly creds: BinanceCredentials) {
    this.http = axios.create({
      baseURL: BINANCE_ENDPOINTS.rest,
      timeout: 10_000,
      headers: { "X-MBX-APIKEY": creds.apiKey },
    });
  }

  // ---------- PUBLIC API SURFACE ----------------------------------------

  /** Server time — used for clock-skew sanity. */
  async serverTime(): Promise<number> {
    const r = await this.publicGet<{ serverTime: number }>("/fapi/v1/time");
    return r.serverTime;
  }

  /** Account balance / margin info. */
  async accountInfo(): Promise<Record<string, unknown>> {
    return this.signedGet("/fapi/v2/account");
  }

  /** Current position(s). */
  async positionRisk(symbol?: string): Promise<Array<Record<string, unknown>>> {
    return this.signedGet("/fapi/v2/positionRisk", symbol ? { symbol } : {});
  }

  /** All open orders for a symbol (or all symbols if omitted). */
  async openOrders(symbol?: string): Promise<Array<Record<string, unknown>>> {
    return this.signedGet("/fapi/v1/openOrders", symbol ? { symbol } : {});
  }

  /** Set leverage. Idempotent — Binance returns OK even on no-op. */
  async setLeverage(symbol: string, leverage: number): Promise<unknown> {
    return this.signedPost("/fapi/v1/leverage", { symbol, leverage });
  }

  /** Set margin type. NOTE: Binance returns error `-4046` if already set;
   *  we silently swallow it because it is functionally a no-op. */
  async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<unknown> {
    try {
      return await this.signedPost("/fapi/v1/marginType", { symbol, marginType });
    } catch (e) {
      const code = (e as AxiosError<{ code?: number }>)?.response?.data?.code;
      if (code === -4046) return { code: -4046, msg: "no change" };
      throw e;
    }
  }

  /** Place an order. The execution layer (riskManager) is what should call
   *  this — it ensures qty is correctly sized. */
  async placeOrder(p: PlaceOrderParams): Promise<Record<string, unknown>> {
    if (this.orderCount >= BinanceFuturesClient.ORDER_CAP_PER_MIN) {
      throw new Error("Local order rate-limit reached; aborting placeOrder.");
    }
    const body: Record<string, unknown> = {
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      ...(p.positionSide && { positionSide: p.positionSide }),
      ...(p.quantity !== undefined && { quantity: p.quantity }),
      ...(p.price !== undefined && { price: p.price }),
      ...(p.stopPrice !== undefined && { stopPrice: p.stopPrice }),
      ...(p.reduceOnly !== undefined && { reduceOnly: p.reduceOnly }),
      ...(p.closePosition !== undefined && { closePosition: p.closePosition }),
      ...(p.timeInForce && { timeInForce: p.timeInForce }),
      ...(p.workingType && { workingType: p.workingType }),
      ...(p.newClientOrderId && { newClientOrderId: p.newClientOrderId }),
    };
    const res = await this.signedPost("/fapi/v1/order", body);
    this.orderCount++;
    return res as Record<string, unknown>;
  }

  /** Cancel a single order. */
  async cancelOrder(symbol: string, orderId?: number, clientOrderId?: string): Promise<unknown> {
    const params: Record<string, unknown> = { symbol };
    if (orderId !== undefined) params.orderId = orderId;
    if (clientOrderId !== undefined) params.origClientOrderId = clientOrderId;
    return this.signedDelete("/fapi/v1/order", params);
  }

  /** Cancel all open orders for a symbol — useful when closing a position. */
  async cancelAllOpenOrders(symbol: string): Promise<unknown> {
    return this.signedDelete("/fapi/v1/allOpenOrders", { symbol });
  }

  /** Exchange filters (LOT_SIZE, PRICE_FILTER, MIN_NOTIONAL) — needed for
   *  rounding qty and price correctly. Cached because it rarely changes. */
  private filtersCache?: Map<string, Record<string, unknown>>;
  async exchangeInfo(): Promise<Map<string, Record<string, unknown>>> {
    if (this.filtersCache) return this.filtersCache;
    const r = await this.publicGet<{ symbols: Array<Record<string, unknown>> }>(
      "/fapi/v1/exchangeInfo"
    );
    const map = new Map<string, Record<string, unknown>>();
    for (const s of r.symbols) map.set(s.symbol as string, s);
    this.filtersCache = map;
    return map;
  }

  // ---------- INTERNALS -------------------------------------------------

  private async publicGet<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    this.assertWeightHeadroom();
    const res = await this.http.get<T>(path, { params });
    this.updateWeightFromHeaders(res);
    return res.data;
  }

  private async signedGet<T = unknown>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    this.assertWeightHeadroom();
    const qs = this.signParams(params);
    const res = await this.http.get<T>(`${path}?${qs}`);
    this.updateWeightFromHeaders(res);
    return res.data;
  }

  private async signedPost<T = unknown>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    this.assertWeightHeadroom();
    const qs = this.signParams(params);
    const res = await this.http.post<T>(`${path}?${qs}`);
    this.updateWeightFromHeaders(res);
    return res.data;
  }

  private async signedDelete<T = unknown>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    this.assertWeightHeadroom();
    const qs = this.signParams(params);
    const res = await this.http.delete<T>(`${path}?${qs}`);
    this.updateWeightFromHeaders(res);
    return res.data;
  }

  /** Build URL-encoded query string + HMAC-SHA256 signature. */
  private signParams(params: Record<string, unknown>): string {
    const merged: Record<string, unknown> = {
      ...params,
      timestamp: Date.now(),
      recvWindow: 5000,
    };
    const qs = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const signature = createHmac("sha256", this.creds.apiSecret).update(qs).digest("hex");
    return `${qs}&signature=${signature}`;
  }

  private updateWeightFromHeaders(res: AxiosResponse): void {
    const h = res.headers as Record<string, string>;
    const used = Number(h["x-mbx-used-weight-1m"] ?? h["X-MBX-USED-WEIGHT-1M"] ?? 0);
    if (!Number.isNaN(used) && used > 0) {
      this.usedWeight = used;
      if (Date.now() > this.weightResetAt) {
        this.weightResetAt = Date.now() + 60_000;
      }
    }
    // Soft-reset order counter every minute.
    if (Date.now() > this.orderResetAt) {
      this.orderCount = 0;
      this.orderResetAt = Date.now() + 60_000;
    }
  }

  private assertWeightHeadroom(): void {
    const cap = BinanceFuturesClient.WEIGHT_CAP * BinanceFuturesClient.WEIGHT_HEADROOM;
    if (this.usedWeight > cap) {
      const sleepMs = Math.max(this.weightResetAt - Date.now(), 1000);
      logger.warn({ usedWeight: this.usedWeight, sleepMs }, "Rate-limit headroom hit; backing off");
      throw new Error(`Rate-limit headroom exceeded (${this.usedWeight}/${BinanceFuturesClient.WEIGHT_CAP}); sleep ${sleepMs}ms`);
    }
  }
}
