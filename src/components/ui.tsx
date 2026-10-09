import type { ReactNode } from "react";
import { titleCase } from "@/lib/format";

type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "demo";

export function Badge({ tone = "neutral", icon, children }: { tone?: Tone; icon?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{icon ? <span aria-hidden="true">{icon}</span> : null}{children}</span>;
}

export const DemoBadge = () => <Badge tone="demo" icon="◈">DEMO / MOCK</Badge>;

export function Tip({ text }: { text: string }) {
  return (
    <span className="tip">
      <button type="button" aria-label={`Definition: ${text}`}>i</button>
      <span className="bubble" role="tooltip">{text}</span>
    </span>
  );
}

export function Kpi({ label, value, sub, help, na }: { label: string; value: ReactNode; sub?: ReactNode; help?: string; na?: boolean }) {
  return (
    <div className={`card kpi${na ? " na" : ""}`}>
      <div className="label">{label}{help ? <Tip text={help} /> : null}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

const DISPOSITION: Record<string, { tone: Tone; icon: string; label: string }> = {
  QUALIFIED: { tone: "ok", icon: "✓", label: "Qualified" },
  CLOSED_NOT_FORWARDED: { tone: "neutral", icon: "—", label: "Closed · not forwarded" },
  DECLINED: { tone: "neutral", icon: "✕", label: "Declined" },
  HUMAN_REVIEW: { tone: "warn", icon: "?", label: "Human review" },
  NEEDS_CLARIFICATION: { tone: "info", icon: "…", label: "Needs clarification" },
  ESCALATED: { tone: "bad", icon: "!", label: "Escalated" },
};
export function DispositionBadge({ value }: { value: string | null }) {
  if (!value) return <Badge tone="neutral" icon="∅">Not assessed</Badge>;
  const d = DISPOSITION[value] ?? { tone: "neutral" as Tone, icon: "·", label: titleCase(value) };
  return <Badge tone={d.tone} icon={d.icon}>{d.label}</Badge>;
}

export function PriorityBadge({ value }: { value: string }) {
  if (value === "urgent") return <Badge tone="bad" icon="▲▲">Urgent</Badge>;
  if (value === "high") return <Badge tone="warn" icon="▲">High</Badge>;
  return <Badge tone="neutral">Normal</Badge>;
}

const CALL: Record<string, { tone: Tone; icon: string; label: string }> = {
  completed: { tone: "ok", icon: "✓", label: "Completed" },
  in_progress: { tone: "info", icon: "◔", label: "In progress" },
  missed: { tone: "bad", icon: "✕", label: "Missed" },
  disconnected: { tone: "warn", icon: "⌁", label: "Disconnected" },
  failed: { tone: "bad", icon: "!", label: "Failed" },
};
export function CallStatusBadge({ value }: { value: string }) {
  const c = CALL[value] ?? { tone: "neutral" as Tone, icon: "·", label: titleCase(value) };
  return <Badge tone={c.tone} icon={c.icon}>{c.label}</Badge>;
}

const NOTE: Record<string, { tone: Tone; icon: string; label: string }> = {
  sent: { tone: "ok", icon: "✓", label: "Sent to Telegram" },
  mock_sent: { tone: "demo", icon: "◈", label: "SIMULATED — not delivered" },
  failed: { tone: "bad", icon: "✕", label: "Delivery failed" },
  unavailable: { tone: "warn", icon: "⚠", label: "Telegram unavailable" },
  pending: { tone: "info", icon: "◔", label: "Pending" },
};
export function NotificationBadge({ value }: { value: string }) {
  const n = NOTE[value] ?? { tone: "neutral" as Tone, icon: "·", label: titleCase(value) };
  return <Badge tone={n.tone} icon={n.icon}>{n.label}</Badge>;
}

export function CriterionBadge({ state }: { state: string }) {
  const m: Record<string, { tone: Tone; icon: string }> = {
    PASS: { tone: "ok", icon: "✓" }, FAIL: { tone: "bad", icon: "✕" }, UNCLEAR: { tone: "warn", icon: "?" }, NOT_APPLICABLE: { tone: "neutral", icon: "–" },
  };
  const c = m[state] ?? { tone: "neutral" as Tone, icon: "·" };
  return <Badge tone={c.tone} icon={c.icon}>{titleCase(state)}</Badge>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><b>{title}</b>{children}</div>;
}

export interface BarDatum { label: string; segments: { value: number; className: string; name: string }[] }

/** Server-rendered stacked bar chart (inline SVG, accessible via table fallback text). */
export function BarChart({ data, height = 160 }: { data: BarDatum[]; height?: number }) {
  if (!data.length) return null;
  const w = Math.max(320, data.length * 34 + 30);
  const max = Math.max(1, ...data.map((d) => d.segments.reduce((a, s) => a + s.value, 0)));
  const bw = Math.min(26, (w - 30) / data.length - 8);
  const colors: Record<string, string> = { q: "var(--ok)", u: "var(--ink-2)", o: "var(--warn)" };
  return (
    <svg className="bar-chart" viewBox={`0 0 ${w} ${height + 24}`} role="img" aria-label={`Calls per day: ${data.map((d) => `${d.label} ${d.segments.reduce((a, s) => a + s.value, 0)}`).join(", ")}`}>
      <line x1="24" y1={height} x2={w} y2={height} stroke="var(--line)" />
      <text x="0" y="10">{max}</text>
      {data.map((d, i) => {
        let y = height;
        const x = 30 + i * ((w - 30) / data.length);
        return (
          <g key={d.label}>
            {d.segments.map((s) => {
              const h = (s.value / max) * (height - 14);
              y -= h;
              return h > 0 ? <rect key={s.name} x={x} y={y} width={bw} height={h} rx="2" fill={colors[s.className]}><title>{`${d.label}: ${s.name} ${s.value}`}</title></rect> : null;
            })}
            <text x={x + bw / 2} y={height + 14} textAnchor="middle">{d.label.slice(5)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className="funnel" role="list" aria-label="Call funnel">
      {steps.map((st) => (
        <div className="step" role="listitem" key={st.label}>
          <span>{st.label}</span>
          <div className="bar" aria-hidden="true"><i style={{ width: `${Math.round((st.value / max) * 100)}%` }} /></div>
          <span className="n">{st.value}</span>
        </div>
      ))}
    </div>
  );
}

export function HeroTile({ label, value, sub, tone = "navy", href }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "navy" | "teal" | "gold" | "alert"; href?: string }) {
  const cls = `tile${tone === "navy" ? "" : ` ${tone}`}`;
  const inner = <><div className="label">{label}</div><div className="value">{value}</div>{sub ? <div className="sub">{sub}</div> : null}</>;
  return href ? <a className={cls} href={href}>{inner}</a> : <div className={cls}>{inner}</div>;
}
