import "./globals.css";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { TopNav } from "@/components/TopNav";

export const metadata: Metadata = {
  title: "AutoTrade — SMC/ICT Dashboard",
  description: "Self-hosted Binance Futures auto-trading bot",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read the active config once per request to drive the TopNav status pills.
  const cfg = await prisma.botConfig.findFirst({ where: { enabled: true } })
    .catch(() => null);

  return (
    <html lang="en">
      <body className="bg-bg text-slate-100 min-h-screen antialiased">
        <TopNav testnet={cfg?.testnet ?? null} enabled={cfg?.enabled ?? null} />
        {children}
      </body>
    </html>
  );
}
