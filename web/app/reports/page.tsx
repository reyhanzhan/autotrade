// ============================================================================
// /reports — Performance report page.
// ----------------------------------------------------------------------------
// Two sections:
//   1. Trade outcomes — overall stats, per-symbol PnL, per-pattern win rate,
//      Coinglass attribution (does confluence actually help?).
//   2. Screening history — every multi-symbol scan: what was looked at,
//      what was picked, what the candidates scored.
//
// Server-rendered. Uses Prisma directly. For a richer chart UI you can swap
// the equity curve table for a `<canvas>` rendered with Chart.js or similar.
// ============================================================================

import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [trades, screeningRuns, snapshotCount] = await Promise.all([
    prisma.trade.findMany({
      where: { closedAt: { gte: since } },
      orderBy: { closedAt: "desc" },
      include: { signal: { select: { kind: true, coinglassScore: true, confidence: true } } },
    }),
    prisma.screeningRun.findMany({
      orderBy: { runAt: "desc" },
      take: 25,
      include: {
        signals: {
          orderBy: { confidence: "desc" },
          select: { id: true, symbol: true, side: true, kind: true, baseConfidence: true, coinglassScore: true, confidence: true, consumed: true },
        },
      },
    }),
    prisma.coinglassSnapshot.count({ where: { capturedAt: { gte: since } } }),
  ]);

  const closed = trades.filter((t) => typeof t.pnl === "number");
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winRate = closed.length ? wins.length / closed.length : 0;
  const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  const bySymbol = aggregateBy(closed, (t) => t.symbol);
  const byKind = aggregateBy(closed, (t) => t.signal?.kind ?? "UNKNOWN");

  const cgWins = wins.map((t) => t.signal?.coinglassScore).filter((v): v is number => typeof v === "number");
  const cgLosses = losses.map((t) => t.signal?.coinglassScore).filter((v): v is number => typeof v === "number");
  const avgCgWins = cgWins.length ? cgWins.reduce((s, v) => s + v, 0) / cgWins.length : null;
  const avgCgLosses = cgLosses.length ? cgLosses.reduce((s, v) => s + v, 0) / cgLosses.length : null;

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Performance Report</h1>
          <p className="text-slate-400 text-sm">Last 30 days · {closed.length} closed trades · {snapshotCount} Coinglass snapshots</p>
        </div>
        <Link href="/" className="text-sm text-accent hover:underline">← Dashboard</Link>
      </header>

      {/* ---- Overall ---- */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Total PnL"     value={`${totalPnl.toFixed(2)} USDT`} tone={totalPnl >= 0 ? "good" : "bad"} />
        <StatCard label="Win rate"      value={`${(winRate * 100).toFixed(1)}%`}  tone={winRate >= 0.5 ? "good" : "warn"} />
        <StatCard label="Profit factor" value={profitFactor ? profitFactor.toFixed(2) : "—"} tone={(profitFactor ?? 0) >= 1.5 ? "good" : "warn"} />
        <StatCard label="Wins / Losses" value={`${wins.length} / ${losses.length}`} />
        <StatCard label="Gross P/L"     value={`${grossProfit.toFixed(0)} / ${grossLoss.toFixed(0)}`} />
      </section>

      {/* ---- Per-symbol ---- */}
      <section className="card">
        <h2 className="text-sm uppercase text-slate-400 mb-3">PnL by symbol</h2>
        <table className="w-full text-sm">
          <thead className="text-slate-400">
            <tr><th className="text-left">Symbol</th><th className="text-right">Trades</th><th className="text-right">Win rate</th><th className="text-right">PnL (USDT)</th></tr>
          </thead>
          <tbody>
            {bySymbol.map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="py-1.5">{r.key}</td>
                <td className="text-right font-mono">{r.trades}</td>
                <td className="text-right font-mono">{(r.winRate * 100).toFixed(0)}%</td>
                <td className={`text-right font-mono ${r.pnl >= 0 ? "text-success" : "text-danger"}`}>{r.pnl.toFixed(2)}</td>
              </tr>
            ))}
            {bySymbol.length === 0 && <tr><td colSpan={4} className="text-slate-500 py-2">No closed trades yet.</td></tr>}
          </tbody>
        </table>
      </section>

      {/* ---- Per-pattern ---- */}
      <section className="card">
        <h2 className="text-sm uppercase text-slate-400 mb-3">PnL by SMC pattern</h2>
        <table className="w-full text-sm">
          <thead className="text-slate-400">
            <tr><th className="text-left">Pattern</th><th className="text-right">Trades</th><th className="text-right">Win rate</th><th className="text-right">PnL</th></tr>
          </thead>
          <tbody>
            {byKind.map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="py-1.5 font-mono">{r.key}</td>
                <td className="text-right font-mono">{r.trades}</td>
                <td className="text-right font-mono">{(r.winRate * 100).toFixed(0)}%</td>
                <td className={`text-right font-mono ${r.pnl >= 0 ? "text-success" : "text-danger"}`}>{r.pnl.toFixed(2)}</td>
              </tr>
            ))}
            {byKind.length === 0 && <tr><td colSpan={4} className="text-slate-500 py-2">No closed trades yet.</td></tr>}
          </tbody>
        </table>
      </section>

      {/* ---- Coinglass attribution ---- */}
      <section className="card">
        <h2 className="text-sm uppercase text-slate-400 mb-3">Coinglass confluence attribution</h2>
        <p className="text-sm text-slate-400 mb-3">
          If Coinglass is helping, the average confluence multiplier on winning trades should
          be <span className="text-success font-mono">higher</span> than on losing trades.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="kv"><span>Avg multiplier on WINS</span><span className="text-success">{avgCgWins?.toFixed(2) ?? "—"} (n={cgWins.length})</span></div>
          <div className="kv"><span>Avg multiplier on LOSSES</span><span className="text-danger">{avgCgLosses?.toFixed(2) ?? "—"} (n={cgLosses.length})</span></div>
        </div>
      </section>

      {/* ---- Trade history ---- */}
      <section className="card">
        <h2 className="text-sm uppercase text-slate-400 mb-3">Recent trades</h2>
        <table className="w-full text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left">Closed</th>
              <th className="text-left">Symbol · Side</th>
              <th className="text-left">Pattern</th>
              <th className="text-right">Entry → Exit</th>
              <th className="text-right">Conf</th>
              <th className="text-right">Reason</th>
              <th className="text-right">PnL</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice(0, 50).map((t) => (
              <tr key={t.id} className="border-t border-line">
                <td className="py-1.5 text-slate-300">{t.closedAt ? new Date(t.closedAt).toLocaleString() : "open"}</td>
                <td><span className={t.side === "LONG" ? "text-success" : "text-danger"}>{t.symbol} {t.side}</span></td>
                <td className="font-mono text-slate-300">{t.signal?.kind ?? "—"}</td>
                <td className="text-right font-mono">{t.entryPrice.toFixed(4)} → {t.exitPrice?.toFixed(4) ?? "—"}</td>
                <td className="text-right font-mono">{t.signal?.confidence ? (t.signal.confidence * 100).toFixed(0) + "%" : "—"}</td>
                <td className="text-right">{t.reason ?? "—"}</td>
                <td className={`text-right font-mono ${(t.pnl ?? 0) >= 0 ? "text-success" : "text-danger"}`}>{t.pnl?.toFixed(2) ?? "—"}</td>
              </tr>
            ))}
            {trades.length === 0 && <tr><td colSpan={7} className="text-slate-500 py-2">No trades yet.</td></tr>}
          </tbody>
        </table>
      </section>

      {/* ---- Screening history ---- */}
      <section className="card">
        <h2 className="text-sm uppercase text-slate-400 mb-3">Screening history</h2>
        <div className="space-y-3">
          {screeningRuns.map((r) => {
            let scanned: string[] = [];
            try { scanned = JSON.parse(r.symbolsScanned); } catch { /* noop */ }
            return (
              <div key={r.id} className="border border-line rounded-lg p-3">
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <span className="text-slate-300">{new Date(r.runAt).toLocaleString()}</span>
                    <span className="text-slate-500"> · scanned {scanned.length} symbols · {r.candidateCount} candidates</span>
                  </div>
                  <div>
                    {r.selectedSymbol
                      ? <span className={r.selectedSide === "LONG" ? "text-success" : "text-danger"}>SELECTED: {r.selectedSymbol} {r.selectedSide} @ {r.bestConfidence?.toFixed(2)}</span>
                      : <span className="text-slate-500">No execution ({r.bestConfidence?.toFixed(2) ?? "—"})</span>}
                  </div>
                </div>
                <p className="text-xs text-slate-500 mt-1">{r.reason}</p>
                {r.signals.length > 0 && (
                  <table className="w-full text-xs mt-2">
                    <thead className="text-slate-500">
                      <tr><th className="text-left">Symbol</th><th className="text-left">Side</th><th className="text-left">Kind</th><th className="text-right">SMC</th><th className="text-right">×CG</th><th className="text-right">Final</th><th className="text-right">Acted</th></tr>
                    </thead>
                    <tbody>
                      {r.signals.map((s) => (
                        <tr key={s.id} className="border-t border-line">
                          <td className="py-0.5">{s.symbol}</td>
                          <td className={s.side === "LONG" ? "text-success" : "text-danger"}>{s.side}</td>
                          <td className="font-mono text-slate-400">{s.kind}</td>
                          <td className="text-right font-mono">{(s.baseConfidence * 100).toFixed(0)}%</td>
                          <td className="text-right font-mono">{s.coinglassScore?.toFixed(2) ?? "—"}</td>
                          <td className="text-right font-mono font-bold">{(s.confidence * 100).toFixed(0)}%</td>
                          <td className="text-right">{s.consumed ? "✓" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
          {screeningRuns.length === 0 && <p className="text-slate-500 text-sm">No screening runs yet.</p>}
        </div>
      </section>
    </main>
  );
}

// ----- helpers ------------------------------------------------------------

function aggregateBy<T extends { pnl: number | null }>(
  rows: T[],
  keyFn: (t: T) => string
): Array<{ key: string; trades: number; wins: number; pnl: number; winRate: number; }> {
  const map = new Map<string, { trades: number; wins: number; pnl: number; }>();
  for (const t of rows) {
    const k = keyFn(t);
    const row = map.get(k) ?? { trades: 0, wins: 0, pnl: 0 };
    row.trades += 1;
    if ((t.pnl ?? 0) > 0) row.wins += 1;
    row.pnl += t.pnl ?? 0;
    map.set(k, row);
  }
  return Array.from(map.entries())
    .map(([key, v]) => ({ key, ...v, winRate: v.trades ? v.wins / v.trades : 0 }))
    .sort((a, b) => b.pnl - a.pnl);
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "warn" }) {
  const c = tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : tone === "warn" ? "text-yellow-400" : "text-slate-100";
  return (
    <div className="card">
      <p className="text-xs uppercase text-slate-400">{label}</p>
      <p className={`text-xl font-mono mt-1 ${c}`}>{value}</p>
    </div>
  );
}
