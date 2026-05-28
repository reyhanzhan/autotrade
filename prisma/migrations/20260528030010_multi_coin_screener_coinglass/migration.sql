-- AlterTable
ALTER TABLE "Position" ADD COLUMN "signalId" INTEGER;

-- CreateTable
CREATE TABLE "ScreeningRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "interval" TEXT NOT NULL,
    "symbolsScanned" TEXT NOT NULL,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "selectedSymbol" TEXT,
    "selectedSide" TEXT,
    "bestConfidence" REAL,
    "reason" TEXT
);

-- CreateTable
CREATE TABLE "CoinglassSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fundingRate" REAL,
    "openInterest" REAL,
    "oiChange24h" REAL,
    "longShortRatio" REAL,
    "liqLong24h" REAL,
    "liqShort24h" REAL,
    "raw" TEXT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BotConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'BINANCE_FUTURES',
    "testnet" BOOLEAN NOT NULL DEFAULT true,
    "apiKeyCipher" TEXT NOT NULL,
    "apiKeyIv" TEXT NOT NULL,
    "apiKeyTag" TEXT NOT NULL,
    "apiSecretCipher" TEXT NOT NULL,
    "apiSecretIv" TEXT NOT NULL,
    "apiSecretTag" TEXT NOT NULL,
    "watchlist" TEXT NOT NULL DEFAULT '[]',
    "symbol" TEXT NOT NULL DEFAULT 'BTCUSDT',
    "interval" TEXT NOT NULL DEFAULT '15m',
    "leverage" INTEGER NOT NULL DEFAULT 5,
    "marginType" TEXT NOT NULL DEFAULT 'ISOLATED',
    "riskPercent" REAL NOT NULL DEFAULT 1.0,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "minConfidence" REAL NOT NULL DEFAULT 0.6,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BotConfig" ("apiKeyCipher", "apiKeyIv", "apiKeyTag", "apiSecretCipher", "apiSecretIv", "apiSecretTag", "createdAt", "enabled", "exchange", "id", "interval", "label", "leverage", "marginType", "maxConcurrent", "riskPercent", "symbol", "testnet", "updatedAt") SELECT "apiKeyCipher", "apiKeyIv", "apiKeyTag", "apiSecretCipher", "apiSecretIv", "apiSecretTag", "createdAt", "enabled", "exchange", "id", "interval", "label", "leverage", "marginType", "maxConcurrent", "riskPercent", "symbol", "testnet", "updatedAt" FROM "BotConfig";
DROP TABLE "BotConfig";
ALTER TABLE "new_BotConfig" RENAME TO "BotConfig";
CREATE UNIQUE INDEX "BotConfig_label_key" ON "BotConfig"("label");
CREATE TABLE "new_Signal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "stopLoss" REAL,
    "takeProfit" REAL,
    "baseConfidence" REAL NOT NULL DEFAULT 0,
    "coinglassScore" REAL,
    "confidence" REAL NOT NULL DEFAULT 0,
    "payload" TEXT,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "screeningRunId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Signal_screeningRunId_fkey" FOREIGN KEY ("screeningRunId") REFERENCES "ScreeningRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Signal" ("confidence", "consumed", "createdAt", "id", "interval", "kind", "payload", "price", "side", "stopLoss", "symbol", "takeProfit") SELECT "confidence", "consumed", "createdAt", "id", "interval", "kind", "payload", "price", "side", "stopLoss", "symbol", "takeProfit" FROM "Signal";
DROP TABLE "Signal";
ALTER TABLE "new_Signal" RENAME TO "Signal";
CREATE INDEX "Signal_symbol_createdAt_idx" ON "Signal"("symbol", "createdAt");
CREATE INDEX "Signal_consumed_idx" ON "Signal"("consumed");
CREATE INDEX "Signal_screeningRunId_idx" ON "Signal"("screeningRunId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ScreeningRun_runAt_idx" ON "ScreeningRun"("runAt");

-- CreateIndex
CREATE INDEX "CoinglassSnapshot_symbol_capturedAt_idx" ON "CoinglassSnapshot"("symbol", "capturedAt");
