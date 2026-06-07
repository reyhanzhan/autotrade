import "server-only";

import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

const CACHE_MS = Number(process.env.LIVE_POSITIONS_CACHE_MS ?? 300_000);

export interface LivePosition {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  rawSize: number;
  entryPrice: number;
  breakEvenPrice: number;
  markPrice: number;
  liquidationPrice: number | null;
  marginRatio: number | null;
  margin: number;
  pnl: number;
  roiPct: number | null;
  fundingRate: number | null;
  estFundingFee: number | null;
  notional: number;
  leverage: number | null;
  updatedAt: string;
}

export interface LivePositionSnapshot {
  positions: LivePosition[];
  updatedAt: string;
  error?: string;
}

let cache: { expiresAt: number; snapshot: LivePositionSnapshot } | undefined;

export async function getLivePositionSnapshot(): Promise<LivePositionSnapshot> {
  if (process.env.LIVE_POSITIONS_ENABLED === "false") {
    return {
      positions: [],
      updatedAt: new Date().toISOString(),
      error: "Live Binance positions disabled by LIVE_POSITIONS_ENABLED=false",
    };
  }

  if (cache && Date.now() < cache.expiresAt) return cache.snapshot;

  try {
    const cfg = await prisma.botConfig.findFirst({ where: { enabled: true } });
    if (!cfg) return { positions: [], updatedAt: new Date().toISOString(), error: "No enabled BotConfig" };

    const apiKey = decryptSecret({ cipher: cfg.apiKeyCipher, iv: cfg.apiKeyIv, tag: cfg.apiKeyTag });
    const apiSecret = decryptSecret({ cipher: cfg.apiSecretCipher, iv: cfg.apiSecretIv, tag: cfg.apiSecretTag });
    const baseURL = cfg.testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
    const signed = new BinanceSignedFetch(baseURL, apiKey, apiSecret);

    const [account, risks, premium] = await Promise.all([
      signed.get<Record<string, unknown>>("/fapi/v2/account"),
      signed.get<Array<Record<string, unknown>>>("/fapi/v2/positionRisk"),
      publicGet<Array<Record<string, unknown>>>(baseURL, "/fapi/v1/premiumIndex").catch(() => []),
    ]);

    const accountPositions = new Map<string, Record<string, unknown>>();
    for (const p of (account.positions as Array<Record<string, unknown>> | undefined) ?? []) {
      accountPositions.set(String(p.symbol), p);
    }
    const funding = new Map<string, number>();
    for (const p of premium) funding.set(String(p.symbol), num(p.lastFundingRate));

    const updatedAt = new Date().toISOString();
    const positions = risks
      .map((risk) => toLivePosition(risk, accountPositions.get(String(risk.symbol)), funding.get(String(risk.symbol)), updatedAt))
      .filter((p): p is LivePosition => !!p)
      .sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional));

    const snapshot = { positions, updatedAt };
    cache = { expiresAt: Date.now() + CACHE_MS, snapshot };
    return snapshot;
  } catch (e) {
    const snapshot = {
      positions: cache?.snapshot.positions ?? [],
      updatedAt: new Date().toISOString(),
      error: (e as Error).message,
    };
    cache = { expiresAt: Date.now() + CACHE_MS, snapshot };
    return snapshot;
  }
}

class BinanceSignedFetch {
  private timeOffsetMs = 0;

  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly apiSecret: string
  ) {}

  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    if (this.timeOffsetMs === 0) await this.syncTime();
    const qs = this.sign(params);
    const res = await fetch(`${this.baseURL}${path}?${qs}`, {
      headers: { "X-MBX-APIKEY": this.apiKey },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(await errorMessage(res, path));
    return res.json() as Promise<T>;
  }

  private async syncTime(): Promise<void> {
    const data = await publicGet<{ serverTime: number }>(this.baseURL, "/fapi/v1/time");
    this.timeOffsetMs = data.serverTime - Date.now();
  }

  private sign(params: Record<string, string | number>): string {
    const merged = {
      ...params,
      timestamp: Date.now() + this.timeOffsetMs,
      recvWindow: 10_000,
    };
    const qs = Object.entries(merged)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const signature = createHmac("sha256", this.apiSecret).update(qs).digest("hex");
    return `${qs}&signature=${signature}`;
  }
}

async function publicGet<T>(baseURL: string, path: string): Promise<T> {
  const res = await fetch(`${baseURL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await errorMessage(res, path));
  return res.json() as Promise<T>;
}

async function errorMessage(res: Response, path: string): Promise<string> {
  let msg = res.statusText;
  let code: unknown;
  try {
    const data = await res.json() as { code?: unknown; msg?: unknown };
    code = data.code;
    msg = String(data.msg ?? msg);
  } catch {
    // keep statusText
  }
  return `Binance ${path} failed status=${res.status}${code !== undefined ? ` code=${code}` : ""} msg=${msg}`;
}

function toLivePosition(
  risk: Record<string, unknown>,
  account: Record<string, unknown> | undefined,
  fundingRate: number | undefined,
  updatedAt: string
): LivePosition | undefined {
  const rawSize = num(risk.positionAmt);
  if (!Number.isFinite(rawSize) || Math.abs(rawSize) <= 0) return;

  const symbol = String(risk.symbol);
  const side = rawSize > 0 ? "LONG" : "SHORT";
  const size = Math.abs(rawSize);
  const entryPrice = num(risk.entryPrice);
  const breakEvenPrice = num(risk.breakEvenPrice) || entryPrice;
  const markPrice = num(risk.markPrice);
  const liquidation = num(risk.liquidationPrice);
  const notional = Math.abs(num(risk.notional) || markPrice * size);
  const leverage = num(risk.leverage) || null;
  const pnl = num(risk.unRealizedProfit ?? risk.unrealizedProfit);
  const margin = Math.max(
    num(account?.positionInitialMargin),
    num(risk.isolatedMargin),
    leverage ? notional / leverage : 0
  );
  const maintMargin = num(account?.maintMargin);
  const marginRatio = margin > 0 && maintMargin > 0 ? (maintMargin / margin) * 100 : null;
  const roiPct = margin > 0 ? (pnl / margin) * 100 : null;
  const estFundingFee = fundingRate !== undefined && Number.isFinite(fundingRate)
    ? notional * fundingRate * (rawSize > 0 ? -1 : 1)
    : null;

  return {
    symbol,
    side,
    size,
    rawSize,
    entryPrice,
    breakEvenPrice,
    markPrice,
    liquidationPrice: liquidation > 0 ? liquidation : null,
    marginRatio,
    margin,
    pnl,
    roiPct,
    fundingRate: fundingRate ?? null,
    estFundingFee,
    notional,
    leverage,
    updatedAt,
  };
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
