// ============================================================================
// StatTile — reusable big-number stat card. Used on Dashboard, Reports, etc.
// ============================================================================

import type { ReactNode } from "react";

export type Tone = "neutral" | "good" | "bad" | "warn" | "accent";

interface Props {
  label: string;
  value: string | number;
  sub?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
}

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "text-slate-100",
  good:    "text-success",
  bad:     "text-danger",
  warn:    "text-yellow-400",
  accent:  "text-accent",
};

export function StatTile({ label, value, sub, tone = "neutral", icon }: Props) {
  return (
    <div className="card">
      <div className="flex items-start justify-between">
        <p className="text-xs uppercase tracking-wider text-slate-400">{label}</p>
        {icon && <div className="text-slate-500">{icon}</div>}
      </div>
      <p className={`text-2xl font-mono font-semibold mt-2 ${TONE_CLASSES[tone]}`}>{value}</p>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}
