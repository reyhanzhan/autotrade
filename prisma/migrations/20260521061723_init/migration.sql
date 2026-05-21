-- CreateTable
CREATE TABLE "BotConfig" (
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
    "symbol" TEXT NOT NULL DEFAULT 'BTCUSDT',
    "interval" TEXT NOT NULL DEFAULT '15m',
    "leverage" INTEGER NOT NULL DEFAULT 5,
    "marginType" TEXT NOT NULL DEFAULT 'ISOLATED',
    "riskPercent" REAL NOT NULL DEFAULT 1.0,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "stopLoss" REAL,
    "takeProfit" REAL,
    "confidence" REAL NOT NULL DEFAULT 0,
    "payload" TEXT,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "exchangeOrderId" TEXT,
    "clientOrderId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "positionSide" TEXT NOT NULL DEFAULT 'BOTH',
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "price" REAL,
    "stopPrice" REAL,
    "quantity" REAL NOT NULL,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "closePosition" BOOLEAN NOT NULL DEFAULT false,
    "rawResponse" TEXT,
    "signalId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "exitPrice" REAL,
    "quantity" REAL NOT NULL,
    "leverage" INTEGER NOT NULL,
    "pnl" REAL,
    "pnlPercent" REAL,
    "reason" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "signalId" INTEGER,
    CONSTRAINT "Trade_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Position" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "quantity" REAL NOT NULL,
    "leverage" INTEGER NOT NULL,
    "stopLoss" REAL,
    "takeProfit" REAL,
    "unrealizedPnl" REAL NOT NULL DEFAULT 0,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "BotConfig_label_key" ON "BotConfig"("label");

-- CreateIndex
CREATE INDEX "Signal_symbol_createdAt_idx" ON "Signal"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "Signal_consumed_idx" ON "Signal"("consumed");

-- CreateIndex
CREATE UNIQUE INDEX "Order_exchangeOrderId_key" ON "Order"("exchangeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientOrderId_key" ON "Order"("clientOrderId");

-- CreateIndex
CREATE INDEX "Order_symbol_status_idx" ON "Order"("symbol", "status");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Trade_symbol_openedAt_idx" ON "Trade"("symbol", "openedAt");

-- CreateIndex
CREATE INDEX "Trade_closedAt_idx" ON "Trade"("closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Position_symbol_key" ON "Position"("symbol");

-- CreateIndex
CREATE INDEX "EventLog_createdAt_idx" ON "EventLog"("createdAt");

-- CreateIndex
CREATE INDEX "EventLog_level_source_idx" ON "EventLog"("level", "source");
