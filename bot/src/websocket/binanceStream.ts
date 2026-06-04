// ============================================================================
// binanceStream.ts — Binance Futures K-Line WebSocket consumer (multi-symbol).
// ----------------------------------------------------------------------------
// Uses Binance's COMBINED-STREAM endpoint:
//   wss://<host>/stream?streams=btcusdt@kline_15m/ethusdt@kline_15m/...
// One TCP socket carries all subscriptions, which is dramatically lighter on
// a small VPS than opening N separate sockets.
//
// Events emitted:
//   'tick'   — every K-Line update (including the still-open candle)
//   'candle' — when a candle finalizes for a given symbol (k.x === true).
//              The event payload is (symbol, candle, all_candles_for_symbol).
//
// Robustness:
//   - Exponential backoff on disconnect (1s → 30s cap)
//   - Heartbeat watchdog: forces reconnect if no data for >90s on any stream
//   - Backoff resets after 60s of stable connection
// ============================================================================

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { logger } from "../shared/logger.js";
import type { Candle } from "../shared/types.js";

interface KlinePayload {
  e: "kline";
  E: number;
  s: string;
  k: {
    t: number; T: number; s: string; i: string;
    o: string; c: string; h: string; l: string; v: string;
    n: number; x: boolean; q: string;
  };
}

interface CombinedEnvelope {
  stream: string;     // e.g. "btcusdt@kline_15m"
  data: KlinePayload;
}

export interface Subscription {
  symbol: string;     // "BTCUSDT"
  interval: string;   // "15m"
}

export interface BinanceStreamOptions {
  subscriptions: Subscription[];
  /** Max candles retained in-memory per symbol (default 500). */
  bufferSize?: number;
  testnet?: boolean;
  wsBaseUrl?: string;
}

export declare interface BinanceStream {
  on(event: "candle", listener: (symbol: string, candle: Candle, all: Candle[]) => void): this;
  on(event: "tick", listener: (symbol: string, candle: Candle) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "close", listener: (code: number, reason: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class BinanceStream extends EventEmitter {
  private ws?: WebSocket;
  /** symbol → ordered candle buffer */
  private buffers = new Map<string, Candle[]>();
  private reconnectAttempts = 0;
  private stableTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private lastMessageAt = 0;
  private closedByUser = false;

  private static readonly MAX_BACKOFF_MS = 30_000;
  private static readonly STABLE_AFTER_MS = 60_000;
  private static readonly WATCHDOG_MS = 90_000;

  constructor(private readonly opts: BinanceStreamOptions) {
    super();
    for (const sub of opts.subscriptions) {
      this.buffers.set(sub.symbol.toUpperCase(), []);
    }
  }

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.closedByUser = false;

    const streams = this.opts.subscriptions
      .map((s) => `${s.symbol.toLowerCase()}@kline_${s.interval}`)
      .join("/");
    const wsBaseUrl = this.opts.wsBaseUrl ?? (
      this.opts.testnet === false ? "wss://fstream.binance.com" : "wss://stream.binancefuture.com"
    );
    const url = `${wsBaseUrl}/stream?streams=${streams}`;
    logger.info({ count: this.opts.subscriptions.length }, "Connecting combined K-Line stream");

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.lastMessageAt = Date.now();
      this.armWatchdog();
      this.armStableTimer();
      this.emit("open");
      logger.info({ streams: this.opts.subscriptions.length }, "WS open");
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      try {
        const env = JSON.parse(raw.toString()) as CombinedEnvelope;
        if (!env.data || env.data.e !== "kline") return;
        const symbol = env.data.s.toUpperCase();
        const c = this.toCandle(env.data);
        this.upsertBuffer(symbol, c);
        this.emit("tick", symbol, c);
        if (c.isClosed) this.emit("candle", symbol, c, [...(this.buffers.get(symbol) ?? [])]);
      } catch (err) {
        logger.warn({ err }, "Malformed WS message");
      }
    });

    ws.on("ping", (data) => { try { ws.pong(data); } catch { /* noop */ } });

    ws.on("error", (err) => {
      logger.error({ err: err.message }, "WS error");
      this.emit("error", err);
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString();
      this.clearWatchdog();
      this.clearStableTimer();
      logger.warn({ code, reason }, "WS closed");
      this.emit("close", code, reason);
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  close(): void {
    this.closedByUser = true;
    this.clearWatchdog();
    this.clearStableTimer();
    if (this.ws) {
      try { this.ws.close(1000, "shutdown"); } catch { /* noop */ }
      this.ws = undefined;
    }
  }

  /** Returns the in-memory candle buffer for a symbol (oldest first). */
  candlesFor(symbol: string): Candle[] {
    return this.buffers.get(symbol.toUpperCase()) ?? [];
  }

  /** All tracked symbols. */
  symbols(): string[] {
    return Array.from(this.buffers.keys());
  }

  // ----- internals --------------------------------------------------------

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      1000 * 2 ** (this.reconnectAttempts - 1),
      BinanceStream.MAX_BACKOFF_MS
    );
    logger.warn({ attempt: this.reconnectAttempts, backoff }, "Reconnecting WS");
    setTimeout(() => this.connect(), backoff);
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastMessageAt;
      if (idleMs > BinanceStream.WATCHDOG_MS) {
        logger.warn({ idleMs }, "WS idle too long — forcing reconnect");
        try { this.ws?.terminate(); } catch { /* noop */ }
      }
    }, 15_000);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined; }
  }

  private armStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => { this.reconnectAttempts = 0; }, BinanceStream.STABLE_AFTER_MS);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = undefined; }
  }

  private toCandle(msg: KlinePayload): Candle {
    const k = msg.k;
    return {
      openTime: k.t, closeTime: k.T,
      open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
      volume: Number(k.v), isClosed: k.x,
    };
  }

  private upsertBuffer(symbol: string, c: Candle): void {
    let buf = this.buffers.get(symbol);
    if (!buf) { buf = []; this.buffers.set(symbol, buf); }
    const last = buf.at(-1);
    if (last && last.openTime === c.openTime) {
      buf[buf.length - 1] = c;
    } else {
      buf.push(c);
      const max = this.opts.bufferSize ?? 500;
      if (buf.length > max) buf.splice(0, buf.length - max);
    }
  }
}
