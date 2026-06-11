// ============================================================================
// env.ts — Loads .env and validates it with zod. Process refuses to start on
// invalid/missing env so misconfiguration fails loudly rather than silently.
// ============================================================================

import "dotenv/config";
import { z } from "zod";

const truthy = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (run `npm run keygen`)"),

  TESTNET: truthy.default("true"),
  SYMBOLS: z.string().default("BTCUSDT"),
  AUTO_DISCOVER_SYMBOLS: truthy.default("false"),
  MAX_SCREENER_SYMBOLS: z.coerce.number().int().min(1).max(200).default(80),
  MIN_24H_QUOTE_VOLUME: z.coerce.number().min(0).default(10_000_000),
  INTERVAL: z
    .enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"])
    .default("15m"),
  DEFAULT_LEVERAGE: z.coerce.number().int().min(1).max(125).default(5),
  DEFAULT_RISK_PERCENT: z.coerce.number().min(0.1).max(50).default(1.0),
  CANDLE_HISTORY: z.coerce.number().int().min(50).max(1500).default(500),
  WARMUP_CANDLES: z.coerce.number().int().min(0).max(1500).default(100),
  ENABLE_MTF_CONFIRMATION: truthy.default("true"),
  MTF_CONFIRMATION_INTERVALS: z.string().default("1h,4h"),
  MTF_RANGING_RISK_MULTIPLIER: z.coerce.number().min(0.1).max(1).default(0.5),
  SCANNING_HEARTBEAT_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  LIVE_TRADING: truthy.default("false"),
  ENABLE_RECONCILER: truthy.default("true"),
  ENABLE_BALANCE_POLLER: truthy.default("true"),
  RECONCILER_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(300_000),
  BALANCE_POLLER_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
  TRADE_SYMBOL_COOLDOWN_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(21_600_000),
  FAILED_TRADE_COOLDOWN_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),

  // Coinglass (all optional — bot works without it)
  COINGLASS_API_KEY: z.string().optional().default(""),
  COINGLASS_BASE_URL: z.string().url().default("https://open-api-v3.coinglass.com"),
  COINGLASS_CACHE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),

  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DASHBOARD_API_TOKEN: z.string().min(16, "DASHBOARD_API_TOKEN must be >= 16 chars"),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = {
  ...parsed.data,
  /** Pre-split list of symbols (uppercased, de-duped). */
  symbolList: dedupe(
    parsed.data.SYMBOLS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  ),
  /** True only if Coinglass key is present. */
  hasCoinglass: parsed.data.COINGLASS_API_KEY.length > 0,
  mtfConfirmationIntervals: dedupe(
    parsed.data.MTF_CONFIRMATION_INTERVALS.split(",")
      .map((s) => s.trim())
      .filter((s) => schema.shape.INTERVAL.safeParse(s).success)
  ),
};

export const BINANCE_ENDPOINTS = {
  rest: env.TESTNET ? "https://testnet.binancefuture.com" : "https://fapi.binance.com",
  ws: env.TESTNET ? "wss://stream.binancefuture.com" : "wss://fstream.binance.com",
} as const;

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
