// Reusable card with a small header bar. Drop-in for ad-hoc panels.
import type { ReactNode } from "react";

export function Card({
  title,
  action,
  className = "",
  children,
}: {
  title?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between mb-3">
          {title && <h2 className="text-sm uppercase tracking-wider text-slate-400">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
