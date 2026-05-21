// ============================================================================
// index.ts — Bot entrypoint (PM2 calls this).
// ----------------------------------------------------------------------------
// Wires graceful shutdown so PM2 reloads don't leave dangling WS sockets or
// open DB connections.
// ============================================================================

import { TradingEngine } from "./engine.js";
import { logger } from "./shared/logger.js";

const engine = new TradingEngine();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");
  await engine.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting");
  process.exit(1);
});

engine.start().catch((err) => {
  logger.fatal({ err }, "Engine failed to start");
  process.exit(1);
});
