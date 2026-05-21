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
  ENCRYPTION_KEY: z
    .string()
    .min(1, "ENCRYPTION_KEY is required (run `npm run keygen`)"),

  TESTNET: truthy.default("true"),
  SYMBOLS: z.string().default("BTCUSDT"),
  INTERVAL: z
    .enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"])
    .default("15m"),
  DEFAULT_LEVERAGE: z.coerce.number().int().min(1).max(125).default(5),
  DEFAULT_RISK_PERCENT: z.coerce.number().min(0.1).max(50).default(1.0),
  CANDLE_HISTORY: z.coerce.number().int().min(50).max(1500).default(500),
  LIVE_TRADING: truthy.default("false"),

  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DASHBOARD_API_TOKEN: z.string().min(16, "DASHBOARD_API_TOKEN must be >= 16 chars"),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print every issue, then exit. Do not throw — PM2 would just restart loop.
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = {
  ...parsed.data,
  /** Pre-split list of symbols (uppercased). */
  symbolList: parsed.data.SYMBOLS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
};

export const BINANCE_ENDPOINTS = {
  rest: env.TESTNET ? "https://testnet.binancefuture.com" : "https://fapi.binance.com",
  ws: env.TESTNET ? "wss://stream.binancefuture.com/ws" : "wss://fstream.binance.com/ws",
} as const;
