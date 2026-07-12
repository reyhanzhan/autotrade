"use client";

import { useEffect, useMemo, useState } from "react";
import type { LivePositionSnapshot } from "@/lib/binanceLive";

export function LivePositionsTable({
  initial,
  dense = false,
}: {
  initial: LivePositionSnapshot;
  dense?: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initial);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/live-positions", { cache: "no-store" });
        if (!res.ok) return;
        const next = await res.json() as LivePositionSnapshot;
        if (alive) setSnapshot(next);
      } catch {
        // Keep the last snapshot visible.
      }
    };
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const positions = snapshot.positions;
  const totalPnl = useMemo(() => positions.reduce((sum, p) => sum + p.pnl, 0), [positions]);

  if (positions.length === 0) {
    return (
      <div className="text-sm text-slate-500">
        No live Binance positions.
        {snapshot.error && <div className="mt-1 text-yellow-300">{snapshot.error}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <span>{positions.length} running position{positions.length === 1 ? "" : "s"}</span>
        <span className={totalPnl >= 0 ? "text-success" : "text-danger"}>
          Total uPnL {money(totalPnl)}
        </span>
        <span>Live cache {new Date(snapshot.updatedAt).toLocaleTimeString()}</span>
      </div>
      {snapshot.error && <div className="text-xs text-yellow-300">{snapshot.error}</div>}
      <div className="overflow-x-auto hide-scrollbar">
        <table className={`t min-w-[1120px] ${dense ? "text-xs" : ""}`}>
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="text-right">Size</th>
              <th className="text-right">Entry Price</th>
              <th className="text-right">Break Even Price</th>
              <th className="text-right">Mark Price</th>
              <th className="text-right">Liq.Price</th>
              <th className="text-right">Margin Ratio</th>
              <th className="text-right">Margin</th>
              <th className="text-right">PNL (ROI %)</th>
              <th className="text-right">Est. Funding Fee</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.symbol}>
                <td>
                  <div className="flex items-center gap-2">
                    <span className="font-mono">{p.symbol}</span>
                    <span className={p.side === "LONG" ? "pill-good" : "pill-bad"}>{p.side}</span>
                  </div>
                </td>
                <td className="text-right font-mono">{fmt(p.size, 6)}</td>
                <td className="text-right font-mono">{fmt(p.entryPrice)}</td>
                <td className="text-right font-mono">{fmt(p.breakEvenPrice)}</td>
                <td className="text-right font-mono">{fmt(p.markPrice)}</td>
                <td className="text-right font-mono">{p.liquidationPrice ? fmt(p.liquidationPrice) : "-"}</td>
                <td className="text-right font-mono">{p.marginRatio == null ? "-" : `${p.marginRatio.toFixed(2)}%`}</td>
                <td className="text-right font-mono">{money(p.margin)}</td>
                <td className={`text-right font-mono ${p.pnl >= 0 ? "text-success" : "text-danger"}`}>
                  {money(p.pnl)}
                  <span className="text-slate-500"> ({p.roiPct == null ? "-" : `${p.roiPct.toFixed(2)}%`})</span>
                </td>
                <td className={`text-right font-mono ${(p.estFundingFee ?? 0) >= 0 ? "text-success" : "text-danger"}`}>
                  {p.estFundingFee == null ? "-" : money(p.estFundingFee)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmt(n: number, max = 4): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

function money(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)} USDT`;
}
