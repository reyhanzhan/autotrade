// ============================================================================
// app/page.tsx — Server-rendered dashboard.
// Shows: active config, multi-symbol watchlist, live positions, recent signals,
// recent screening runs, and latest engine events. Links to /reports.
// ============================================================================

import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [cfg, positions, recentSignals, recentRuns, recentEvents] = await Promise.all([
    prisma.botConfig.findFirst({ where: { enabled: true } }),
    prisma.position.findMany({ orderBy: { openedAt: "desc" } }),
    prisma.signal.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.screeningRun.findMany({ orderBy: { runAt: "desc" }, take: 5 }),
    prisma.eventLog.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
  ]);

  let watchlist: string[] = [];
  try { if (cfg?.watchlist) watchlist = JSON.parse(cfg.watchlist); } catch { /* noop */ }

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">AutoTrade — SMC/ICT</h1>
          <p className="text-slate-400 text-sm">
            {cfg
              ? `${watchlist.length || 1} symbol${watchlist.length === 1 ? "" : "s"} · ${cfg.interval} · ${cfg.testnet ? "TESTNET" : "MAINNET"} · ${cfg.leverage}x ${cfg.marginType} · min conf ${cfg.minConfidence}`
              : "No active config — POST /api/config to set credentials."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/reports" className="text-sm text-accent hover:underline">Reports →</Link>
          <div className={`text-sm px-3 py-1.5 rounded-md ${cfg?.enabled ? "bg-success/20 text-success" : "bg-slate-700 text-slate-300"}`}>
            {cfg?.enabled ? "ENABLED" : "DISABLED"}
          </div>
        </div>
      </header>

      {/* Watchlist */}
      <section className="card">
        <h2 className="text-sm uppercase text-slate-400 mb-3">Watchlist (screener universe)</h2>
        {watchlist.length === 0
          ? <p className="text-slate-500 text-sm">No watchlist configured — using env default.</p>
          : <div className="flex flex-wrap gap-2">
              {watchlist.map((s) => (
                <span key={s} className="px-2.5 py-1 rounded-md bg-muted text-slate-200 text-xs font-mono">{s}</span>
              ))}
            </div>}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <h2 className="text-sm uppercase text-slate-400 mb-3">Open positions</h2>
          {positions.length === 0
            ? <p className="text-slate-500 text-sm">No active positions.</p>
            : positions.map((p) => (
                <div key={p.id} className="border-b border-line py-2 last:border-0">
                  <div className="kv"><span>Symbol</span><span>{p.symbol}</span></div>
                  <div className="kv"><span>Side</span><span className={p.side === "LONG" ? "text-success" : "text-danger"}>{p.side}</span></div>
                  <div className="kv"><span>Entry</span><span>{p.entryPrice.toFixed(4)}</span></div>
                  <div className="kv"><span>Qty</span><span>{p.quantity}</span></div>
                  <div className="kv"><span>uPnL</span><span className={p.unrealizedPnl >= 0 ? "text-success" : "text-danger"}>{p.unrealizedPnl.toFixed(2)}</span></div>
                  <div className="kv"><span>SL / TP</span><span>{p.stopLoss?.toFixed(4)} / {p.takeProfit?.toFixed(4)}</span></div>
                </div>
              ))}
        </div>

        <div className="card md:col-span-2">
          <h2 className="text-sm uppercase text-slate-400 mb-3">Recent signals (across all symbols)</h2>
          <table className="w-full text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left">When</th>
                <th className="text-left">Symbol</th>
                <th className="text-left">Pattern</th>
                <th className="text-right">SMC</th>
                <th className="text-right">×CG</th>
                <th className="text-right">Final</th>
                <th className="text-right">Acted</th>
              </tr>
            </thead>
            <tbody>
              {recentSignals.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="py-1.5 text-slate-300">{new Date(s.createdAt).toLocaleString()}</td>
                  <td className="font-mono">{s.symbol}</td>
                  <td className={s.side === "LONG" ? "text-success" : "text-danger"}>{s.kind}</td>
                  <td className="text-right font-mono">{(s.baseConfidence * 100).toFixed(0)}%</td>
                  <td className="text-right font-mono">{s.coinglassScore?.toFixed(2) ?? "—"}</td>
                  <td className="text-right font-mono font-bold">{(s.confidence * 100).toFixed(0)}%</td>
                  <td className="text-right">{s.consumed ? "✓" : "—"}</td>
                </tr>
              ))}
              {recentSignals.length === 0 && (
                <tr><td colSpan={7} className="text-slate-500 py-2">No signals yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-sm uppercase text-slate-400 mb-3">Recent screening runs</h2>
          {recentRuns.length === 0
            ? <p className="text-slate-500 text-sm">No screening runs yet.</p>
            : recentRuns.map((r) => (
                <div key={r.id} className="border-b border-line py-2 last:border-0 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300">{new Date(r.runAt).toLocaleString()}</span>
                    <span className="text-xs text-slate-500">{r.candidateCount} candidates</span>
                  </div>
                  <div className="text-xs mt-1">
                    {r.selectedSymbol
                      ? <span className={r.selectedSide === "LONG" ? "text-success" : "text-danger"}>{r.selectedSymbol} {r.selectedSide} @ {r.bestConfidence?.toFixed(2)}</span>
                      : <span className="text-slate-500">No execution</span>}
                  </div>
                </div>
              ))}
          <Link href="/reports" className="text-xs text-accent hover:underline mt-3 inline-block">View full screening history →</Link>
        </div>

        <div className="card">
          <h2 className="text-sm uppercase text-slate-400 mb-3">Engine events</h2>
          <ul className="text-sm space-y-1 max-h-72 overflow-auto">
            {recentEvents.map((e) => (
              <li key={e.id} className="font-mono">
                <span className="text-slate-500">{new Date(e.createdAt).toLocaleTimeString()}</span>
                {" "}
                <span className={e.level === "error" ? "text-danger" : e.level === "warn" ? "text-yellow-400" : "text-slate-300"}>
                  [{e.source}] {e.message}
                </span>
              </li>
            ))}
            {recentEvents.length === 0 && <li className="text-slate-500">No events yet.</li>}
          </ul>
        </div>
      </section>
    </main>
  );
}
