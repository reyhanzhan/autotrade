// ============================================================================
// app/page.tsx — Dashboard.
// Hero: wallet balance + 24h Δ + equity sparkline + today's PnL + win-rate.
// Below: watchlist, open positions, recent signals, screening runs, events.
// ============================================================================

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card } from "@/components/Card";
import { StatTile } from "@/components/StatTile";
import { Sparkline } from "@/components/Sparkline";
import { LivePositionsTable } from "@/components/LivePositionsTable";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getLivePositionSnapshot } from "@/lib/binanceLive";
import { formatWibDateTime, formatWibTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);

  const [cfg, positions, recentSignals, recentRuns, recentEvents,
         latestBalance, balance24hAgo, balanceHistory,
         todaysClosed, last30dClosed, livePositions] = await Promise.all([
    prisma.botConfig.findFirst({ where: { enabled: true } }),
    prisma.position.findMany({ orderBy: { openedAt: "desc" } }),
    prisma.signal.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.screeningRun.findMany({ orderBy: { runAt: "desc" }, take: 5 }),
    prisma.eventLog.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.balanceSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
    prisma.balanceSnapshot.findFirst({
      where: { capturedAt: { lte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      orderBy: { capturedAt: "desc" },
    }),
    prisma.balanceSnapshot.findMany({ orderBy: { capturedAt: "desc" }, take: 200 }),
    prisma.trade.findMany({
      where: { closedAt: { gte: startOfDay }, pnl: { not: null } },
      select: { pnl: true },
    }),
    prisma.trade.findMany({
      where: { closedAt: { gte: since30d }, pnl: { not: null } },
      select: { pnl: true },
    }),
    getLivePositionSnapshot(),
  ]);

  let watchlist: string[] = [];
  try { if (cfg?.watchlist) watchlist = JSON.parse(cfg.watchlist); } catch { /* noop */ }
  const autoDiscover = process.env.AUTO_DISCOVER_SYMBOLS === "true" || process.env.AUTO_DISCOVER_SYMBOLS === "1";
  const universeLabel = autoDiscover
    ? `top ${process.env.MAX_SCREENER_SYMBOLS ?? "80"} liquid futures symbols`
    : `${watchlist.length} symbol${watchlist.length === 1 ? "" : "s"}`;
  const min24hQuoteVolume = Number(process.env.MIN_24H_QUOTE_VOLUME ?? 10_000_000);

  // ----- hero stats -------------------------------------------------------
  const wallet = latestBalance?.totalWalletBalance ?? 0;
  const unrealized = latestBalance?.unrealizedProfit ?? 0;
  const available = latestBalance?.availableBalance ?? 0;

  const delta24h = latestBalance && balance24hAgo
    ? latestBalance.totalWalletBalance - balance24hAgo.totalWalletBalance
    : null;
  const deltaPct24h = delta24h !== null && balance24hAgo && balance24hAgo.totalWalletBalance > 0
    ? (delta24h / balance24hAgo.totalWalletBalance) * 100
    : null;

  const todayPnl = todaysClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const monthPnl = last30dClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins30d = last30dClosed.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate30d = last30dClosed.length > 0 ? wins30d / last30dClosed.length : 0;

  const sparkPoints = balanceHistory.slice().reverse().map((b) => b.totalWalletBalance);

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <AutoRefresh />
      {/* Header */}
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-slate-400 text-sm">
          {cfg
            ? `${universeLabel} · ${cfg.interval} · ${cfg.leverage}x ${cfg.marginType} · risk ${cfg.riskPercent}% · max ${cfg.maxConcurrent === 0 ? "unlimited" : cfg.maxConcurrent} positions`
            : "No active config — POST /api/config first."}
        </p>
      </header>

      {/* Hero balance + stats */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Wallet Balance" className="md:col-span-1">
          {latestBalance ? (
            <>
              <p className="text-3xl font-mono font-semibold">{wallet.toFixed(2)} <span className="text-base text-slate-400">USDT</span></p>
              <div className="text-xs text-slate-400 mt-1">
                Available <span className="text-slate-200 font-mono">{available.toFixed(2)}</span>
                <span className="mx-2">·</span>
                uPnL <span className={`font-mono ${unrealized >= 0 ? "text-success" : "text-danger"}`}>{unrealized.toFixed(2)}</span>
              </div>
              {delta24h !== null && (
                <div className="mt-2">
                  <span className={delta24h >= 0 ? "pill-good" : "pill-bad"}>
                    {delta24h >= 0 ? "▲" : "▼"} {delta24h.toFixed(2)} USDT
                    {deltaPct24h !== null && ` (${deltaPct24h.toFixed(2)}%)`}
                  </span>
                  <span className="text-xs text-slate-500 ml-2">24h</span>
                </div>
              )}
              <div className="mt-3">
                <Sparkline points={sparkPoints} color="auto" width={280} height={56} />
              </div>
              <p className="text-[10px] text-slate-500 mt-1">
                Last update: {formatWibTime(latestBalance.capturedAt)} · {balanceHistory.length} snapshots
              </p>
            </>
          ) : (
            <div className="text-sm text-slate-500">
              No balance snapshots yet. The bot polls Binance every 60s once it starts.
            </div>
          )}
        </Card>

        <div className="grid grid-cols-2 gap-4 md:col-span-2">
          <StatTile
            label="Today's PnL"
            value={`${todayPnl >= 0 ? "+" : ""}${todayPnl.toFixed(2)}`}
            sub={`${todaysClosed.length} trade${todaysClosed.length === 1 ? "" : "s"} today`}
            tone={todayPnl >= 0 ? "good" : "bad"}
          />
          <StatTile
            label="30-Day PnL"
            value={`${monthPnl >= 0 ? "+" : ""}${monthPnl.toFixed(2)}`}
            sub={`${last30dClosed.length} closed`}
            tone={monthPnl >= 0 ? "good" : "bad"}
          />
          <StatTile
            label="Win Rate (30d)"
            value={`${(winRate30d * 100).toFixed(0)}%`}
            sub={`${wins30d}/${last30dClosed.length}`}
            tone={winRate30d >= 0.5 ? "good" : winRate30d >= 0.3 ? "warn" : "bad"}
          />
          <StatTile
            label="Running Positions"
            value={livePositions.positions.length}
            sub={livePositions.positions.length > 0 ? livePositions.positions.map((p) => `${p.symbol} ${p.side}`).join(", ") : "none"}
            tone={livePositions.positions.length > 0 ? "accent" : "neutral"}
          />
        </div>
      </section>

      <Card title="Running Positions (Live Binance)">
        <LivePositionsTable initial={livePositions} />
      </Card>

      {/* Watchlist */}
      <Card
        title={autoDiscover ? "Auto-Discovered Screener Universe" : "Watchlist"}
        action={<Link href="/calendar" className="text-xs text-accent hover:underline">View PnL calendar →</Link>}
      >
        {autoDiscover
          ? <p className="text-slate-500 text-sm">Scanning top {process.env.MAX_SCREENER_SYMBOLS ?? "80"} Binance USDT perpetual symbols by 24h quote volume, minimum {min24hQuoteVolume.toLocaleString("en-US")} USDT.</p>
          : watchlist.length === 0
          ? <p className="text-slate-500 text-sm">No watchlist — using env default.</p>
          : <div className="flex flex-wrap gap-2">
              {watchlist.map((s) => {
                const inPos = positions.find((p) => p.symbol === s);
                return (
                  <span
                    key={s}
                    className={`pill ${inPos ? (inPos.side === "LONG" ? "pill-good" : "pill-bad") : "pill-neut"}`}
                  >
                    {s}{inPos ? ` · ${inPos.side}` : ""}
                  </span>
                );
              })}
            </div>}
      </Card>

      {/* Positions + signals */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Open Positions" className="md:col-span-1">
          {positions.length === 0
            ? <p className="text-slate-500 text-sm">No active positions.</p>
            : positions.map((p) => (
                <div key={p.id} className="border-b border-line py-2 last:border-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono">{p.symbol}</span>
                    <span className={p.side === "LONG" ? "pill-good" : "pill-bad"}>{p.side}</span>
                  </div>
                  <div className="kv"><span>Entry</span><span>{p.entryPrice.toFixed(4)}</span></div>
                  <div className="kv"><span>Qty</span><span>{p.quantity}</span></div>
                  <div className="kv">
                    <span>uPnL</span>
                    <span className={p.unrealizedPnl >= 0 ? "text-success" : "text-danger"}>{p.unrealizedPnl.toFixed(2)}</span>
                  </div>
                  <div className="kv"><span>SL · TP</span><span>{p.stopLoss?.toFixed(4)} · {p.takeProfit?.toFixed(4)}</span></div>
                </div>
              ))}
        </Card>

        <Card title="Recent Signals (all symbols)" className="md:col-span-2">
          <table className="t">
            <thead>
              <tr>
                <th>Time</th><th>Symbol</th><th>Pattern</th>
                <th className="text-right">SMC</th>
                <th className="text-right">×CG</th>
                <th className="text-right">Final</th>
                <th className="text-right">Acted</th>
              </tr>
            </thead>
            <tbody>
              {recentSignals.map((s) => (
                <tr key={s.id}>
                  <td className="text-slate-400 text-xs">{formatWibTime(s.createdAt)}</td>
                  <td className="font-mono">{s.symbol}</td>
                  <td><span className={s.side === "LONG" ? "pill-good" : "pill-bad"}>{s.kind}</span></td>
                  <td className="text-right font-mono">{(s.baseConfidence * 100).toFixed(0)}%</td>
                  <td className="text-right font-mono text-slate-400">{s.coinglassScore?.toFixed(2) ?? "—"}</td>
                  <td className="text-right font-mono font-bold">{(s.confidence * 100).toFixed(0)}%</td>
                  <td className="text-right">{s.consumed ? <span className="text-success">●</span> : <span className="text-slate-600">○</span>}</td>
                </tr>
              ))}
              {recentSignals.length === 0 && (
                <tr><td colSpan={7} className="text-slate-500 py-3">No signals yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>

      {/* Screening + events */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card
          title="Recent Screening Runs"
          action={<Link href="/reports" className="text-xs text-accent hover:underline">All runs →</Link>}
        >
          {recentRuns.length === 0
            ? <p className="text-slate-500 text-sm">No screening runs yet.</p>
            : recentRuns.map((r) => (
                <div key={r.id} className="border-b border-line py-2 last:border-0">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-300">{formatWibDateTime(r.runAt)}</span>
                    <span className="text-xs text-slate-500">{r.candidateCount} candidates</span>
                  </div>
                  <div className="text-xs mt-1">
                    {r.selectedSymbol
                      ? <span className={r.selectedSide === "LONG" ? "text-success" : "text-danger"}>
                          ✓ {r.selectedSymbol} {r.selectedSide} @ {r.bestConfidence?.toFixed(2)}
                        </span>
                      : <span className="text-slate-500">No execution{r.bestConfidence != null ? ` · best ${r.bestConfidence.toFixed(2)}` : ""}</span>}
                  </div>
                </div>
              ))}
        </Card>

        <Card title="Engine Events">
          <ul className="text-sm space-y-1 max-h-72 overflow-auto font-mono">
            {recentEvents.map((e) => (
              <li key={e.id} className="text-xs">
                <span className="text-slate-600">{formatWibTime(e.createdAt)}</span>{" "}
                <span className={e.level === "error" ? "text-danger" : e.level === "warn" ? "text-yellow-400" : "text-slate-300"}>
                  [{e.source}] {e.message}
                </span>
              </li>
            ))}
            {recentEvents.length === 0 && <li className="text-slate-500">No events yet.</li>}
          </ul>
        </Card>
      </section>
    </main>
  );
}
