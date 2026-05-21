// ============================================================================
// GET  /api/config           — return current (non-sensitive) bot config
// POST /api/config           — create or update the bot config; encrypts
//                              apiKey + apiSecret with AES-256-GCM BEFORE
//                              they ever touch the DB. The plaintext leaves
//                              the request body and exists only in memory
//                              until decrypted by the bot at signal time.
// ============================================================================

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  label: z.string().min(1).max(64).default("default"),
  testnet: z.boolean().default(true),
  apiKey: z.string().min(10),
  apiSecret: z.string().min(10),
  symbol: z.string().regex(/^[A-Z0-9]{4,20}$/).default("BTCUSDT"),
  interval: z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"]).default("15m"),
  leverage: z.number().int().min(1).max(125).default(5),
  marginType: z.enum(["ISOLATED", "CROSSED"]).default("ISOLATED"),
  riskPercent: z.number().min(0.1).max(50).default(1.0),
  maxConcurrent: z.number().int().min(1).max(10).default(1),
  enabled: z.boolean().default(false),
});

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const cfg = await prisma.botConfig.findFirst({ orderBy: { id: "asc" } });
  if (!cfg) return NextResponse.json({ config: null });

  // Never return the encrypted ciphertext to the client.
  return NextResponse.json({
    config: {
      id: cfg.id,
      label: cfg.label,
      testnet: cfg.testnet,
      symbol: cfg.symbol,
      interval: cfg.interval,
      leverage: cfg.leverage,
      marginType: cfg.marginType,
      riskPercent: cfg.riskPercent,
      maxConcurrent: cfg.maxConcurrent,
      enabled: cfg.enabled,
      updatedAt: cfg.updatedAt,
    },
  });
}

export async function POST(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  let parsed;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: "Invalid body", details: (e as Error).message }, { status: 400 });
  }

  const k = encryptSecret(parsed.apiKey);
  const s = encryptSecret(parsed.apiSecret);

  const existing = await prisma.botConfig.findFirst({ where: { label: parsed.label } });
  const data = {
    label: parsed.label,
    testnet: parsed.testnet,
    apiKeyCipher: k.cipher, apiKeyIv: k.iv, apiKeyTag: k.tag,
    apiSecretCipher: s.cipher, apiSecretIv: s.iv, apiSecretTag: s.tag,
    symbol: parsed.symbol,
    interval: parsed.interval,
    leverage: parsed.leverage,
    marginType: parsed.marginType,
    riskPercent: parsed.riskPercent,
    maxConcurrent: parsed.maxConcurrent,
    enabled: parsed.enabled,
  };

  const cfg = existing
    ? await prisma.botConfig.update({ where: { id: existing.id }, data })
    : await prisma.botConfig.create({ data });

  return NextResponse.json({ ok: true, id: cfg.id });
}
