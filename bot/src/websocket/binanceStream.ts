// ============================================================================
// binanceStream.ts — Binance Futures K-Line WebSocket consumer.
// ----------------------------------------------------------------------------
// Subscribes to `<symbol>@kline_<interval>` streams. Emits two event types:
//   - 'tick'     — every incoming K-Line update (open candle), high-frequency
//   - 'candle'   — only when a candle finalizes (kline.x === true)
//
// Robustness features:
//   - Exponential backoff on disconnect (1s → 30s cap)
//   - Heartbeat watchdog: forces reconnect if no data for >90s
//   - Backoff resets after 60s of stable connection
//   - Graceful close on SIGINT/SIGTERM via close()
//
// Per Binance docs, WS connections are valid for 24h and may be closed by the
// server; the reconnect logic handles that automatically.
// ============================================================================

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { BINANCE_ENDPOINTS } from "../shared/env.js";
import { logger } from "../shared/logger.js";
import type { Candle } from "../shared/types.js";

interface KlinePayload {
  e: "kline";
  E: number;            // event time
  s: string;            // symbol
  k: {
    t: number;          // start time
    T: number;          // close time
    s: string;          // symbol
    i: string;          // interval
    f: number;          // first trade id
    L: number;          // last trade id
    o: string;          // open
    c: string;          // close
    h: string;          // high
    l: string;          // low
    v: string;          // base asset volume
    n: number;          // trade count
    x: boolean;         // is this kline closed?
    q: string;          // quote asset volume
    V: string;          // taker buy base
    Q: string;          // taker buy quote
  };
}

export interface BinanceStreamOptions {
  symbol: string;       // e.g. "BTCUSDT"
  interval: string;     // e.g. "15m"
  /** Optional: max candles retained in the in-memory buffer (default 500). */
  bufferSize?: number;
}

export declare interface BinanceStream {
  on(event: "candle", listener: (candle: Candle, all: Candle[]) => void): this;
  on(event: "tick", listener: (candle: Candle) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "close", listener: (code: number, reason: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class BinanceStream extends EventEmitter {
  private ws?: WebSocket;
  private buffer: Candle[] = [];
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
  }

  /** Open the connection. Idempotent: returns silently if already connected. */
  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.closedByUser = false;

    const stream = `${this.opts.symbol.toLowerCase()}@kline_${this.opts.interval}`;
    const url = `${BINANCE_ENDPOINTS.ws}/${stream}`;
    logger.info({ url }, "Connecting Binance K-Line stream");

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.lastMessageAt = Date.now();
      this.armWatchdog();
      this.armStableTimer();
      this.emit("open");
      logger.info({ stream }, "WS open");
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      try {
        const data = JSON.parse(raw.toString()) as KlinePayload;
        if (data.e !== "kline") return;
        const c = this.toCandle(data);
        this.upsertBuffer(c);
        this.emit("tick", c);
        if (c.isClosed) this.emit("candle", c, [...this.buffer]);
      } catch (err) {
        logger.warn({ err }, "Malformed WS message");
      }
    });

    ws.on("ping", (data) => {
      // `ws` auto-replies with pong, but we explicitly pong with the same
      // payload to be safe across server expectations.
      try { ws.pong(data); } catch { /* socket may already be closing */ }
    });

    ws.on("error", (err) => {
      logger.error({ err: err.message }, "WS error");
      this.emit("error", err);
      // 'close' will fire next; reconnect is handled there.
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

  /** Gracefully close. The stream will not auto-reconnect after this. */
  close(): void {
    this.closedByUser = true;
    this.clearWatchdog();
    this.clearStableTimer();
    if (this.ws) {
      try { this.ws.close(1000, "shutdown"); } catch { /* noop */ }
      this.ws = undefined;
    }
  }

  /** Current in-memory candle buffer (oldest first). */
  candles(): Candle[] {
    return this.buffer;
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
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private armStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      // After STABLE_AFTER_MS without disconnect, reset the backoff counter.
      this.reconnectAttempts = 0;
    }, BinanceStream.STABLE_AFTER_MS);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  private toCandle(msg: KlinePayload): Candle {
    const k = msg.k;
    return {
      openTime: k.t,
      closeTime: k.T,
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
      isClosed: k.x,
    };
  }

  /** Replace the current (open) candle in-place; append on roll-over. */
  private upsertBuffer(c: Candle): void {
    const last = this.buffer.at(-1);
    if (last && last.openTime === c.openTime) {
      this.buffer[this.buffer.length - 1] = c;
    } else {
      this.buffer.push(c);
      const max = this.opts.bufferSize ?? 500;
      if (this.buffer.length > max) {
        this.buffer.splice(0, this.buffer.length - max);
      }
    }
  }
}
