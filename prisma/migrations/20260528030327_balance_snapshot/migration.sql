-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalWalletBalance" REAL NOT NULL,
    "availableBalance" REAL NOT NULL,
    "marginBalance" REAL NOT NULL,
    "unrealizedProfit" REAL NOT NULL DEFAULT 0,
    "testnet" BOOLEAN NOT NULL DEFAULT true
);

-- CreateIndex
CREATE INDEX "BalanceSnapshot_capturedAt_idx" ON "BalanceSnapshot"("capturedAt");
