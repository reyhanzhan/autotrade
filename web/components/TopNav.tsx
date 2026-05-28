// ============================================================================
// TopNav — global navigation bar used across all pages.
// ----------------------------------------------------------------------------
// Client component so we can highlight the active route via usePathname().
// ============================================================================

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/",          label: "Dashboard" },
  { href: "/calendar",  label: "Calendar"  },
  { href: "/reports",   label: "Reports"   },
  { href: "/settings",  label: "Settings"  },
];

export function TopNav({ testnet, enabled }: { testnet?: boolean | null; enabled?: boolean | null }) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-10 backdrop-blur bg-bg/80 border-b border-line">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight">
            AutoTrade<span className="text-accent">.</span>
          </Link>
          <nav className="flex items-center gap-1">
            {ITEMS.map((it) => {
              const active = pathname === it.href || (it.href !== "/" && pathname.startsWith(it.href));
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={`px-3 py-1.5 rounded-md text-sm transition ${
                    active
                      ? "bg-muted text-white"
                      : "text-slate-400 hover:text-slate-100 hover:bg-muted/50"
                  }`}
                >
                  {it.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {testnet !== null && testnet !== undefined && (
            <span className={`text-xs px-2 py-0.5 rounded ${
              testnet ? "bg-yellow-500/15 text-yellow-300" : "bg-purple-500/15 text-purple-300"
            }`}>
              {testnet ? "TESTNET" : "MAINNET"}
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded ${
            enabled ? "bg-success/15 text-success" : "bg-slate-700 text-slate-300"
          }`}>
            {enabled ? "● ENABLED" : "○ DISABLED"}
          </span>
        </div>
      </div>
    </header>
  );
}
