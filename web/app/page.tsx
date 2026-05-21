// ============================================================================
// app/page.tsx — Server-rendered dashboard (no client-side fetch needed for
// the initial paint). Uses Prisma directly via the Next.js server runtime.
//
// For a live-updating panel, add a small "use client" component that polls
// /api/status every 5s with the bearer token from a session cookie. The
// scaffolding below is deliberately minimal — focus is the data plumbing,
// not the UI library.
// ============================================================================

import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [cfg, positions, recentTrades, recentSignals, recentEvents] = await Promise.all([
    prisma.botConfig.findFirst({ where: { enabled: true } }),
    prisma.position.findMany({ orderBy: { openedAt: "desc" } }),
    prisma.trade.findMany({ orderBy: { openedAt: "desc" }, take: 10 }),
    prisma.signal.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.eventLog.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
  ]);

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">AutoTrade — SMC/ICT</h1>
          <p className="text-slate-400 text-sm">
            {cfg
              ? `${cfg.symbol} · ${cfg.interval} · ${cfg.testnet ? "TESTNET" : "MAINNET"} · ${cfg.leverage}x ${cfg.marginType}`
              : "No active config — POST /api/config to set credentials."}
          </p>
        </div>
        <div className={`text-sm px-3 py-1.5 rounded-md ${cfg?.enabled ? "bg-success/20 text-success" : "bg-slate-700 text-slate-300"}`}>
          {cfg?.enabled ? "ENABLED" : "DISABLED"}
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <h2 className="text-sm uppercase text-slate-400 mb-3">Open Positions</h2>
          {positions.length === 0
            ? <p className="text-slate-500 text-sm">No active positions.</p>
            : positions.map((p) => (
                <div key={p.id} className="border-b border-line py-2 last:border-0">
                  <div className="kv"><span>Symbol</span><span>{p.symbol}</span></div>
                  <div className="kv"><span>Side</span><span className={p.side === "LONG" ? "text-success" : "text-danger"}>{p.side}</span></div>
                  <div className="kv"><span>Entry</span><span>{p.entryPrice.toFixed(2)}</span></div>
                  <div className="kv"><span>Qty</span><span>{p.quantity}</span></div>
                  <div className="kv"><span>SL / TP</span><span>{p.stopLoss?.toFixed(2)} / {p.takeProfit?.toFixed(2)}</span></div>
                </div>
              ))}
        </div>

        <div className="card md:col-span-2">
          <h2 className="text-sm uppercase text-slate-400 mb-3">Recent Signals</h2>
          <table className="w-full text-sm">
            <thead className="text-slate-400">
              <tr><th className="text-left">When</th><th className="text-left">Kind</th><th className="text-right">Entry</th><th className="text-right">SL</th><th className="text-right">TP</th><th className="text-right">Conf</th></tr>
            </thead>
            <tbody>
              {recentSignals.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="py-1.5 text-slate-300">{new Date(s.createdAt).toLocaleString()}</td>
                  <td className={s.side === "LONG" ? "text-success" : "text-danger"}>{s.kind}</td>
                  <td className="text-right font-mono">{s.price.toFixed(2)}</td>
                  <td className="text-right font-mono">{s.stopLoss?.toFixed(2)}</td>
                  <td className="text-right font-mono">{s.takeProfit?.toFixed(2)}</td>
                  <td className="text-right font-mono">{(s.confidence * 100).toFixed(0)}%</td>
                </tr>
              ))}
              {recentSignals.length === 0 && (
                <tr><td colSpan={6} className="text-slate-500 py-2">No signals yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-sm uppercase text-slate-400 mb-3">Recent Trades</h2>
          {recentTrades.length === 0
            ? <p className="text-slate-500 text-sm">No closed trades yet.</p>
            : recentTrades.map((t) => (
                <div key={t.id} className="border-b border-line py-2 last:border-0 text-sm">
                  <div className="kv"><span>{t.symbol} · {t.side}</span><span className={Number(t.pnl ?? 0) >= 0 ? "text-success" : "text-danger"}>{t.pnl?.toFixed(2) ?? "—"} USDT</span></div>
                  <div className="kv"><span>Entry → Exit</span><span>{t.entryPrice.toFixed(2)} → {t.exitPrice?.toFixed(2) ?? "open"}</span></div>
                  <div className="kv"><span>Reason</span><span>{t.reason ?? "—"}</span></div>
                </div>
              ))}
        </div>

        <div className="card">
          <h2 className="text-sm uppercase text-slate-400 mb-3">Engine Events</h2>
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
