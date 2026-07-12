// ============================================================================
// /calendar — Monthly PnL heatmap.
// ----------------------------------------------------------------------------
// Server-rendered. The month is read from `?y=2026&m=5` (UTC). Days are color-
// shaded by realized PnL: green = profit, red = loss, gray = no trades.
// ============================================================================

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card } from "@/components/Card";
import { StatTile } from "@/components/StatTile";

export const dynamic = "force-dynamic";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface SearchParams { y?: string; m?: string; }

export default async function CalendarPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const now = new Date();
  const year = Number(sp.y ?? now.getUTCFullYear());
  const month = clampMonth(Number(sp.m ?? now.getUTCMonth() + 1));

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const trades = await prisma.trade.findMany({
    where: { closedAt: { gte: start, lt: end } },
    select: { closedAt: true, pnl: true, symbol: true, side: true },
  });

  // Bucket by UTC date.
  const map = new Map<string, { pnl: number; trades: number; wins: number; losses: number; symbols: Set<string>; }>();
  for (const t of trades) {
    if (!t.closedAt) continue;
    const key = t.closedAt.toISOString().slice(0, 10);
    const row = map.get(key) ?? { pnl: 0, trades: 0, wins: 0, losses: 0, symbols: new Set<string>() };
    row.pnl += t.pnl ?? 0;
    row.trades += 1;
    if ((t.pnl ?? 0) > 0) row.wins += 1;
    if ((t.pnl ?? 0) < 0) row.losses += 1;
    row.symbols.add(t.symbol);
    map.set(key, row);
  }

  const days = buildMonthGrid(year, month, map);
  const summary = summarize(days);

  const prev = monthShift(year, month, -1);
  const next = monthShift(year, month, +1);
  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleString(undefined, {
    month: "long", year: "numeric", timeZone: "UTC",
  });

  // Color scale: clamp PnL by max(|pnl|) in this month so the strongest day
  // is the most saturated.
  const maxAbs = days.reduce((m, d) => Math.max(m, Math.abs(d?.pnl ?? 0)), 0);

  return (
    <main className="max-w-6xl mx-auto p-4 md:p-6 space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">PnL Calendar</h1>
        <div className="flex items-center gap-2">
          <Link href={`/calendar?y=${prev.y}&m=${prev.m}`} className="btn-ghost">← {monthShort(prev.y, prev.m)}</Link>
          <Link href={`/calendar?y=${now.getUTCFullYear()}&m=${now.getUTCMonth() + 1}`} className="btn-ghost">Today</Link>
          <Link href={`/calendar?y=${next.y}&m=${next.m}`} className="btn-ghost">{monthShort(next.y, next.m)} →</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatTile label={monthLabel} value={`${summary.totalPnl.toFixed(2)}`} sub="USDT total" tone={summary.totalPnl >= 0 ? "good" : "bad"} />
        <StatTile label="Trades" value={summary.trades} sub={`${summary.wins}W · ${summary.losses}L`} />
        <StatTile label="Win rate" value={`${(summary.winRate * 100).toFixed(0)}%`} tone={summary.winRate >= 0.5 ? "good" : "warn"} />
        <StatTile label="Profit days" value={summary.positiveDays} tone="good" />
        <StatTile label="Loss days" value={summary.negativeDays} tone="bad" />
      </div>

      <Card title={monthLabel}>
        <div className="grid grid-cols-7 gap-1 text-xs text-slate-500 mb-1">
          {WEEKDAY_LABELS.map((w) => <div key={w} className="text-center py-1">{w}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((d, i) => d === null ? (
            <div key={`empty-${i}`} className="min-h-[68px]" />
          ) : (
            <DayCell key={d.date} {...d} maxAbs={maxAbs} />
          ))}
        </div>
        <Legend maxAbs={maxAbs} />
      </Card>
    </main>
  );
}

// ----- DayCell ------------------------------------------------------------

function DayCell({
  date, pnl, trades, wins, losses, symbols, maxAbs,
}: { date: string; pnl: number; trades: number; wins: number; losses: number; symbols: string[]; maxAbs: number; }) {
  const day = Number(date.slice(8, 10));
  const isFuture = new Date(date + "T23:59:59Z") > new Date();
  const todayIso = new Date().toISOString().slice(0, 10);
  const isToday = date === todayIso;

  // Color intensity from 0..0.6 alpha, scaled by |pnl|/maxAbs.
  let bg = "transparent";
  if (trades > 0 && maxAbs > 0) {
    const intensity = Math.min(0.6, 0.1 + (Math.abs(pnl) / maxAbs) * 0.5);
    bg = pnl >= 0
      ? `rgba(16, 185, 129, ${intensity})`   // success/green
      : `rgba(239, 68, 68, ${intensity})`;   // danger/red
  }

  return (
    <div
      className={`cal-day ${isToday ? "ring-1 ring-accent" : ""} ${isFuture ? "opacity-40" : ""}`}
      style={{ backgroundColor: bg }}
      title={trades > 0 ? `${date} — ${pnl.toFixed(2)} USDT (${wins}W ${losses}L), ${symbols.join(", ")}` : `${date} — no trades`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-300">{day}</span>
        {trades > 0 && <span className="text-[10px] text-slate-400">{trades}t</span>}
      </div>
      {trades > 0 ? (
        <div className={`text-xs font-mono ${pnl >= 0 ? "text-success" : "text-danger"}`}>
          {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
        </div>
      ) : (
        <div className="text-[10px] text-slate-600">—</div>
      )}
    </div>
  );
}

function Legend({ maxAbs }: { maxAbs: number }) {
  if (maxAbs === 0) return null;
  return (
    <div className="flex items-center gap-3 text-xs text-slate-500 mt-3">
      <span>Loss</span>
      <div className="flex">
        {[0.6, 0.4, 0.2, 0.1].map((a) => <span key={"r" + a} className="w-4 h-3 inline-block" style={{ backgroundColor: `rgba(239, 68, 68, ${a})` }} />)}
        <span className="w-4 h-3 inline-block bg-muted" />
        {[0.1, 0.2, 0.4, 0.6].map((a) => <span key={"g" + a} className="w-4 h-3 inline-block" style={{ backgroundColor: `rgba(16, 185, 129, ${a})` }} />)}
      </div>
      <span>Profit</span>
      <span className="ml-auto">±{maxAbs.toFixed(2)} USDT max-day</span>
    </div>
  );
}

// ----- helpers ------------------------------------------------------------

type DayEntry = { date: string; pnl: number; trades: number; wins: number; losses: number; symbols: string[]; };

function buildMonthGrid(year: number, month: number, byDay: Map<string, { pnl: number; trades: number; wins: number; losses: number; symbols: Set<string>; }>): Array<DayEntry | null> {
  const out: Array<DayEntry | null> = [];
  const firstWeekdayMon0 = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // Mon=0
  for (let i = 0; i < firstWeekdayMon0; i++) out.push(null);
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = new Date(Date.UTC(year, month - 1, d)).toISOString().slice(0, 10);
    const row = byDay.get(date);
    out.push({
      date,
      pnl: row?.pnl ?? 0,
      trades: row?.trades ?? 0,
      wins: row?.wins ?? 0,
      losses: row?.losses ?? 0,
      symbols: row ? Array.from(row.symbols) : [],
    });
  }
  return out;
}

function summarize(days: Array<DayEntry | null>) {
  const filled = days.filter((d): d is DayEntry => d !== null);
  const totalPnl = filled.reduce((s, d) => s + d.pnl, 0);
  const trades = filled.reduce((s, d) => s + d.trades, 0);
  const wins = filled.reduce((s, d) => s + d.wins, 0);
  const losses = filled.reduce((s, d) => s + d.losses, 0);
  return {
    totalPnl, trades, wins, losses,
    winRate: trades ? wins / trades : 0,
    positiveDays: filled.filter((d) => d.pnl > 0).length,
    negativeDays: filled.filter((d) => d.pnl < 0).length,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampMonth(m: number): number {
  if (!Number.isFinite(m) || m < 1 || m > 12) return new Date().getUTCMonth() + 1;
  return m;
}

function monthShift(year: number, month: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

function monthShort(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString(undefined, { month: "short", timeZone: "UTC" });
}
