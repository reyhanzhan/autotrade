import { NextResponse } from "next/server";
import { getLivePositionSnapshot } from "@/lib/binanceLive";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getLivePositionSnapshot();
  return NextResponse.json(snapshot);
}
