// ============================================================================
// logger.ts — Pino structured logger.
// ----------------------------------------------------------------------------
// Pino is one of the fastest Node loggers and emits JSON by default, which
// PM2 and most log shippers consume natively. `pino-pretty` is enabled only
// in non-production so logs are human-readable during local dev.
// ============================================================================

import pino from "pino";
import { env } from "./env.js";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "autotrade-bot" },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      }),
});

/** Persist a structured event to the DB EventLog table (and also emit to pino). */
export async function recordEvent(
  source: string,
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
): Promise<void> {
  logger[level]({ source, ...meta }, message);
  try {
    const { prisma } = await import("./db.js");
    await prisma.eventLog.create({
      data: {
        level,
        source,
        message,
        meta: meta ? JSON.stringify(meta) : null,
      },
    });
  } catch (err) {
    // Don't let a DB-logging failure crash the engine.
    logger.error({ err }, "Failed to persist EventLog row");
  }
}
