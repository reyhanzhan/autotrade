// ============================================================================
// /settings — Read-only view of the current bot config.
// ----------------------------------------------------------------------------
// Editing is done via POST /api/config — see the curl snippet below. We keep
// this page deliberately read-only to avoid building a credential form in the
// browser (your API keys should never live in browser memory).
// ============================================================================

import { prisma } from "@/lib/db";
import { Card } from "@/components/Card";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const cfg = await prisma.botConfig.findFirst({ orderBy: { id: "asc" } });
  let watchlist: string[] = [];
  try { if (cfg?.watchlist) watchlist = JSON.parse(cfg.watchlist); } catch { /* noop */ }

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-slate-400 text-sm">Configuration is read-only here. Update via the API (snippet below).</p>
      </header>

      <Card title="Current Bot Config">
        {!cfg ? (
          <p className="text-slate-500 text-sm">No config yet — POST to <code className="font-mono text-accent">/api/config</code> to create one.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
            <div className="kv"><span>Label</span><span>{cfg.label}</span></div>
            <div className="kv"><span>Status</span><span className={cfg.enabled ? "pill-good" : "pill-neut"}>{cfg.enabled ? "ENABLED" : "DISABLED"}</span></div>
            <div className="kv"><span>Network</span><span className={cfg.testnet ? "pill-warn" : "pill-good"}>{cfg.testnet ? "TESTNET" : "MAINNET"}</span></div>
            <div className="kv"><span>Interval</span><span>{cfg.interval}</span></div>
            <div className="kv"><span>Leverage</span><span>{cfg.leverage}x</span></div>
            <div className="kv"><span>Margin Type</span><span>{cfg.marginType}</span></div>
            <div className="kv"><span>Risk per trade</span><span>{cfg.riskPercent}%</span></div>
            <div className="kv"><span>Min confidence</span><span>{cfg.minConfidence}</span></div>
            <div className="kv"><span>Max concurrent</span><span>{cfg.maxConcurrent}</span></div>
            <div className="kv"><span>Last updated</span><span>{new Date(cfg.updatedAt).toLocaleString()}</span></div>
          </div>
        )}
      </Card>

      <Card title="Watchlist (screener universe)">
        {watchlist.length === 0
          ? <p className="text-slate-500 text-sm">No watchlist configured — using env <code className="font-mono">SYMBOLS</code> default.</p>
          : <div className="flex flex-wrap gap-2">
              {watchlist.map((s) => <span key={s} className="pill-neut">{s}</span>)}
            </div>}
      </Card>

      <Card title="Update via API">
        <p className="text-sm text-slate-400 mb-3">
          Authenticate every request with the <code className="font-mono">DASHBOARD_API_TOKEN</code> from your <code className="font-mono">.env</code>.
        </p>
        <pre className="text-xs bg-bg border border-line rounded-md p-3 overflow-auto font-mono">{`curl -X POST http://localhost:3000/api/config \\
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "label": "binance-futures-testnet",
    "testnet": true,
    "apiKey":    "YOUR_TESTNET_KEY",
    "apiSecret": "YOUR_TESTNET_SECRET",
    "watchlist": ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","LINKUSDT","AVAXUSDT"],
    "symbol": "BTCUSDT",
    "interval": "15m",
    "leverage": 5,
    "marginType": "ISOLATED",
    "riskPercent": 1.0,
    "maxConcurrent": 1,
    "minConfidence": 0.6,
    "enabled": true
  }'`}</pre>
        <p className="text-xs text-slate-500 mt-3">
          The route uses AES-256-GCM to encrypt API keys before storing them. After updating, restart the bot:
          <code className="ml-1 font-mono">pm2 restart autotrade-bot</code>.
        </p>
      </Card>
    </main>
  );
}
