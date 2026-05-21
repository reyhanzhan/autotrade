// ============================================================================
// web/lib/auth.ts — Bearer-token guard for /api/* routes.
// ----------------------------------------------------------------------------
// Self-hosted single-user model: every protected endpoint requires
//   Authorization: Bearer <DASHBOARD_API_TOKEN>
// Use timingSafeEqual to avoid leaking the token via timing.
// ============================================================================

import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export function requireAuth(req: Request): NextResponse | null {
  const expected = process.env.DASHBOARD_API_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "Server token not configured" }, { status: 500 });
  }
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const got = Buffer.from(match[1]!);
  const exp = Buffer.from(expected);
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  return null;
}
