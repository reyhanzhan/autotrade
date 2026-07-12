// ============================================================================
// /reports — Performance report page.
// ----------------------------------------------------------------------------
// Sections:
//   - Hero stats (Total PnL, Win rate, Profit factor, etc.)
//   - PnL by symbol
//   - PnL by SMC pattern
//   - Coinglass attribution (avg ×multiplier on wins vs losses)
//   - Recent closed trades
//   - Screening history (what was scanned / picked / why)
// ============================================================================

import { prisma } from "@/lib/db";
import { Card } from "@/components/Card";
import { StatTile } from "@/components/StatTile";
import { LivePositionsTable } from "@/components/LivePositionsTable";
import { getLivePositionSnapshot } from "@/lib/binanceLive";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [trades, screeningRuns, snapshotCount, livePositions] = await Promise.all([
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
    getLivePositionSnapshot(),
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
    <main className="max-w-6xl mx-auto p-4 md:p-6 space-y-4 md:space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-slate-400 text-sm">Last 30 days · {closed.length} closed trades · {snapshotCount} Coinglass snapshots</p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatTile label="Total PnL"     value={`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`} sub="USDT" tone={totalPnl >= 0 ? "good" : "bad"} />
        <StatTile label="Win Rate"      value={`${(winRate * 100).toFixed(1)}%`}  sub={`${wins.length} / ${closed.length}`} tone={winRate >= 0.5 ? "good" : "warn"} />
        <StatTile label="Profit Factor" value={profitFactor ? profitFactor.toFixed(2) : "—"} tone={(profitFactor ?? 0) >= 1.5 ? "good" : "warn"} />
        <StatTile label="Gross Profit"  value={grossProfit.toFixed(0)} tone="good" />
        <StatTile label="Gross Loss"    value={grossLoss.toFixed(0)} tone="bad" />
      </section>

      <Card title="Running Positions Tree">
        {livePositions.positions.length === 0 ? (
          <p className="text-slate-500 text-sm">No live Binance positions.</p>
        ) : (
          <div className="space-y-2">
            {livePositions.positions.map((p) => (
              <details key={p.symbol} className="border border-line rounded-lg p-3" open>
                <summary className="cursor-pointer list-none flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{p.symbol}</span>
                    <span className={p.side === "LONG" ? "pill-good" : "pill-bad"}>{p.side}</span>
                  </span>
                  <span className={`font-mono ${p.pnl >= 0 ? "text-success" : "text-danger"}`}>
                    {p.pnl >= 0 ? "+" : ""}{p.pnl.toFixed(2)} USDT
                    {p.roiPct != null && <span className="text-slate-500"> ({p.roiPct.toFixed(2)}%)</span>}
                  </span>
                </summary>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-x-6 mt-3">
                  <div className="kv"><span>Size</span><span>{p.size.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span></div>
                  <div className="kv"><span>Entry</span><span>{p.entryPrice.toFixed(6)}</span></div>
                  <div className="kv"><span>Break Even</span><span>{p.breakEvenPrice.toFixed(6)}</span></div>
                  <div className="kv"><span>Mark</span><span>{p.markPrice.toFixed(6)}</span></div>
                  <div className="kv"><span>Liq.</span><span>{p.liquidationPrice?.toFixed(6) ?? "-"}</span></div>
                  <div className="kv"><span>Margin Ratio</span><span>{p.marginRatio == null ? "-" : `${p.marginRatio.toFixed(2)}%`}</span></div>
                  <div className="kv"><span>Margin</span><span>{p.margin.toFixed(2)}</span></div>
                  <div className="kv"><span>Notional</span><span>{p.notional.toFixed(2)}</span></div>
                  <div className="kv"><span>Funding Rate</span><span>{p.fundingRate == null ? "-" : `${(p.fundingRate * 100).toFixed(4)}%`}</span></div>
                  <div className="kv"><span>Est. Funding</span><span>{p.estFundingFee == null ? "-" : `${p.estFundingFee.toFixed(4)} USDT`}</span></div>
                </div>
              </details>
            ))}
            <LivePositionsTable initial={livePositions} dense />
          </div>
        )}
      </Card>

      <Card title="PnL by Symbol">
        <div className="overflow-x-auto hide-scrollbar">
          <table className="t min-w-[400px]">
            <thead><tr><th>Symbol</th><th className="text-right">Trades</th><th className="text-right">Win rate</th><th className="text-right">PnL</th></tr></thead>
          <tbody>
            {bySymbol.map((r) => (
              <tr key={r.key}>
                <td className="font-mono">{r.key}</td>
                <td className="text-right font-mono">{r.trades}</td>
                <td className="text-right font-mono">{(r.winRate * 100).toFixed(0)}%</td>
                <td className={`text-right font-mono ${r.pnl >= 0 ? "text-success" : "text-danger"}`}>{r.pnl.toFixed(2)}</td>
              </tr>
            ))}
            {bySymbol.length === 0 && <tr><td colSpan={4} className="text-slate-500 py-3">No closed trades yet.</td></tr>}
          </tbody>
        </table>
        </div>
      </Card>

      <Card title="PnL by SMC Pattern">
        <div className="overflow-x-auto hide-scrollbar">
          <table className="t min-w-[400px]">
            <thead><tr><th>Pattern</th><th className="text-right">Trades</th><th className="text-right">Win rate</th><th className="text-right">PnL</th></tr></thead>
          <tbody>
            {byKind.map((r) => (
              <tr key={r.key}>
                <td className="font-mono">{r.key}</td>
                <td className="text-right font-mono">{r.trades}</td>
                <td className="text-right font-mono">{(r.winRate * 100).toFixed(0)}%</td>
                <td className={`text-right font-mono ${r.pnl >= 0 ? "text-success" : "text-danger"}`}>{r.pnl.toFixed(2)}</td>
              </tr>
            ))}
            {byKind.length === 0 && <tr><td colSpan={4} className="text-slate-500 py-3">No closed trades yet.</td></tr>}
          </tbody>
        </table>
        </div>
      </Card>

      <Card title="Coinglass Confluence Attribution">
        <p className="text-sm text-slate-400 mb-3">
          If Coinglass is improving accuracy, the average confluence multiplier on winning
          trades should be <span className="text-success font-mono">higher</span> than on losing trades.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="kv"><span>Avg multiplier · WINS</span><span className="text-success">{avgCgWins?.toFixed(2) ?? "—"} <span className="text-slate-500 text-xs">(n={cgWins.length})</span></span></div>
          <div className="kv"><span>Avg multiplier · LOSSES</span><span className="text-danger">{avgCgLosses?.toFixed(2) ?? "—"} <span className="text-slate-500 text-xs">(n={cgLosses.length})</span></span></div>
        </div>
      </Card>

      <Card title="Recent Trades">
        <div className="overflow-x-auto hide-scrollbar">
          <table className="t min-w-[600px]">
            <thead>
            <tr>
              <th>Closed</th>
              <th>Symbol · Side</th>
              <th>Pattern</th>
              <th className="text-right">Entry → Exit</th>
              <th className="text-right">Conf</th>
              <th className="text-right">Reason</th>
              <th className="text-right">PnL</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice(0, 50).map((t) => (
              <tr key={t.id}>
                <td className="text-slate-400 text-xs">{t.closedAt ? new Date(t.closedAt).toLocaleString() : "open"}</td>
                <td><span className={t.side === "LONG" ? "pill-good" : "pill-bad"}>{t.symbol} {t.side}</span></td>
                <td className="font-mono text-slate-300">{t.signal?.kind ?? "—"}</td>
                <td className="text-right font-mono">{t.entryPrice.toFixed(4)} → {t.exitPrice?.toFixed(4) ?? "—"}</td>
                <td className="text-right font-mono">{t.signal?.confidence ? (t.signal.confidence * 100).toFixed(0) + "%" : "—"}</td>
                <td className="text-right">{t.reason ? <span className="pill-neut">{t.reason}</span> : "—"}</td>
                <td className={`text-right font-mono ${(t.pnl ?? 0) >= 0 ? "text-success" : "text-danger"}`}>{t.pnl?.toFixed(2) ?? "—"}</td>
              </tr>
            ))}
            {trades.length === 0 && <tr><td colSpan={7} className="text-slate-500 py-3">No trades yet.</td></tr>}
          </tbody>
        </table>
        </div>
      </Card>

      <Card title="Screening History">
        <div className="space-y-3">
          {screeningRuns.map((r) => {
            let scanned: string[] = [];
            try { scanned = JSON.parse(r.symbolsScanned); } catch { /* noop */ }
            return (
              <div key={r.id} className="border border-line rounded-lg p-3">
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <span className="text-slate-300">{new Date(r.runAt).toLocaleString()}</span>
                    <span className="text-slate-500"> · scanned {scanned.length} · {r.candidateCount} candidates</span>
                  </div>
                  <div>
                    {r.selectedSymbol
                      ? <span className={r.selectedSide === "LONG" ? "pill-good" : "pill-bad"}>SELECTED: {r.selectedSymbol} {r.selectedSide} @ {r.bestConfidence?.toFixed(2)}</span>
                      : <span className="text-slate-500 text-xs">No execution ({r.bestConfidence?.toFixed(2) ?? "—"})</span>}
                  </div>
                </div>
                <p className="text-xs text-slate-500 mt-1">{r.reason}</p>
                {r.signals.length > 0 && (
                  <div className="overflow-x-auto hide-scrollbar">
                    <table className="t text-xs mt-2 min-w-[500px]">
                      <thead><tr><th>Symbol</th><th>Side</th><th>Kind</th><th className="text-right">SMC</th><th className="text-right">×CG</th><th className="text-right">Final</th><th className="text-right">Acted</th></tr></thead>
                    <tbody>
                      {r.signals.map((s) => (
                        <tr key={s.id}>
                          <td className="font-mono">{s.symbol}</td>
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
                  </div>
                )}
              </div>
            );
          })}
          {screeningRuns.length === 0 && <p className="text-slate-500 text-sm">No screening runs yet.</p>}
        </div>
      </Card>
    </main>
  );
}

// ----- helpers ------------------------------------------------------------

function aggregateBy<T extends { pnl: number | null }>(
  rows: T[], keyFn: (t: T) => string
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
