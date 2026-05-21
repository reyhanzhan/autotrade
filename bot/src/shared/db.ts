// ============================================================================
// db.ts — Prisma client singleton.
// ----------------------------------------------------------------------------
// Multiple `new PrismaClient()` instances exhaust DB connections on small
// VPS quickly. Hot-reload (tsx watch) creates new module instances, so we
// stash the client on globalThis to survive reloads in dev.
// ============================================================================

import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace"
      ? ["query", "warn", "error"]
      : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
