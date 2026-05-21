import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AutoTrade — SMC/ICT Dashboard",
  description: "Self-hosted Binance Futures auto-trading bot",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-bg text-slate-100 min-h-screen antialiased">{children}</body>
    </html>
  );
}
