"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/reports", label: "Reports" },
  { href: "/calendar", label: "Calendar" },
  { href: "/settings", label: "Settings" },
];

export function TopNav({ testnet, enabled }: { testnet?: boolean | null; enabled?: boolean | null }) {
  const pathname = usePathname();
  const status = (
    <div className="flex flex-wrap items-center gap-2">
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
        {enabled ? "ONLINE" : "DISABLED"}
      </span>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:flex fixed inset-y-0 left-0 z-20 w-64 border-r border-line bg-panel/95 backdrop-blur flex-col">
        <div className="h-16 px-5 flex items-center border-b border-line">
          <Link href="/" className="font-semibold tracking-tight text-lg">
            AutoTrade<span className="text-accent">.</span>
          </Link>
        </div>
        <nav className="p-3 space-y-1">
          {ITEMS.map((item) => <NavItem key={item.href} item={item} pathname={pathname} />)}
        </nav>
        <div className="mt-auto p-4 border-t border-line">
          {status}
          <p className="mt-3 text-xs text-slate-500 leading-relaxed">
            Futures execution, live position monitoring, and SMC screening.
          </p>
        </div>
      </aside>

      <header className="lg:hidden sticky top-0 z-20 backdrop-blur bg-bg/90 border-b border-line">
        <div className="px-4 h-14 flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight">
            AutoTrade<span className="text-accent">.</span>
          </Link>
          {status}
        </div>
        <nav className="px-2 pb-2 flex gap-1 overflow-x-auto hide-scrollbar">
          {ITEMS.map((item) => <NavItem key={item.href} item={item} pathname={pathname} compact />)}
        </nav>
      </header>
    </>
  );
}

function NavItem({
  item,
  pathname,
  compact = false,
}: {
  item: { href: string; label: string };
  pathname: string;
  compact?: boolean;
}) {
  const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
  return (
    <Link
      href={item.href}
      className={`${compact ? "shrink-0 px-3 py-1.5" : "block px-3 py-2"} rounded-md text-sm transition ${
        active
          ? "bg-muted text-white"
          : "text-slate-400 hover:text-slate-100 hover:bg-muted/60"
      }`}
    >
      {item.label}
    </Link>
  );
}
