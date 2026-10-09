"use client";

import Link from "next/link";
import { useState } from "react";
import { APPROVED_PRICING_RESPONSE } from "@/modules/pricing-guardrails";
import { Badge, DemoBadge, DispositionBadge, NotificationBadge } from "@/components/ui";

interface Result {
  enquiryId?: string; ref: string | null; disposition: string | null; callStatus?: string; expectedDisposition: string | null;
  transcript: { role: string; text: string }[]; events: string[];
  notifications: { category: string; status: string; preview: string | null }[];
}

export function Simulator({ scenarios }: { scenarios: { id: string; title: string; expected: string }[] }) {
  const [mode, setMode] = useState<"scenario" | "custom">("scenario");
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.id ?? "");
  const [lines, setLines] = useState("Hi, I have a 3BHK in Baner and want a complete redesign with execution. How much would it cost?\nWe're flexible on timing, no rush. Yes, I'm the owner.");
  const [outcome, setOutcome] = useState("completed");
  const [noTimestamp, setNoTimestamp] = useState(false);
  const [delay, setDelay] = useState("3");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setResult(null);
    const body: Record<string, unknown> = { outcome };
    if (mode === "scenario") body.scenarioId = scenarioId;
    else body.callerLines = lines.split("\n").map((t) => t.trim()).filter(Boolean).map((text) => ({ text }));
    body.firstResponseDelaySec = noTimestamp ? null : Number(delay);
    if (cost.trim()) body.providerCostInr = Number(cost);
    const res = await fetch("/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(data.issues?.[0]?.message ?? data.error ?? "Simulation failed."); return; }
    setResult(data);
  }

  return (
    <div className="grid two">
      <form className="card grid" onSubmit={run} style={{ alignContent: "start" }} aria-label="Simulate an incoming call">
        <header><h2>Simulate an incoming call <DemoBadge /></h2></header>
        <div role="radiogroup" aria-label="Input type" className="row">
          <label className="row" style={{ flexDirection: "row", gap: 6 }}><input style={{ width: "auto", minHeight: 0 }} type="radio" checked={mode === "scenario"} onChange={() => setMode("scenario")} />PDF transcript scenario</label>
          <label className="row" style={{ flexDirection: "row", gap: 6 }}><input style={{ width: "auto", minHeight: 0 }} type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} />Type caller statements</label>
        </div>
        {mode === "scenario" ? (
          <label>Scenario (anonymised phone calls T01–T20)
            <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>{scenarios.map((s) => <option key={s.id} value={s.id}>{s.id} — {s.title}</option>)}</select>
          </label>
        ) : (
          <label>Caller statements — one per line, in order
            <textarea value={lines} onChange={(e) => setLines(e.target.value)} rows={6} maxLength={8000} />
          </label>
        )}
        <label>Call outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="completed">Completed conversation</option><option value="missed">Missed call (no transcript)</option>
            <option value="disconnected">Disconnected mid-call</option><option value="failed">Provider failure</option>
          </select>
        </label>
        <div className="filters" style={{ marginBottom: 0 }}>
          <label>Simulated first-response delay (s)<input type="number" min="0" max="3600" value={delay} disabled={noTimestamp} onChange={(e) => setDelay(e.target.value)} /></label>
          <label>Simulated provider cost (₹, optional)<input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="empty → unknown/estimated" /></label>
        </div>
        <label className="row" style={{ flexDirection: "row", gap: 8, fontWeight: 500 }}><input style={{ width: "auto", minHeight: 0 }} type="checkbox" checked={noTimestamp} onChange={(e) => setNoTimestamp(e.target.checked)} />Provider sends no response timestamp (metric becomes unmeasurable)</label>
        <p className="muted small">Uses the same rules engine, pricing guardrail, database and notification code as real calls. Records are flagged DEMO. Telegram output is a preview only.</p>
        <button className="btn" disabled={busy}>{busy ? "Running…" : "Run simulated call"}</button>
        {error ? <p className="err" role="alert">{error}</p> : null}
      </form>

      <div className="grid" style={{ alignContent: "start" }} aria-live="polite">
        {!result ? <div className="card muted">Results appear here: the conversation, the qualification decision, the Telegram preview and the stored record.</div> : (
          <>
            <section className="card"><header><h2>Outcome</h2>{result.ref ? <Link className="btn small" href={`/enquiries/${result.enquiryId}?scope=demo`}>Open {result.ref} →</Link> : null}</header>
              <div className="row" style={{ gap: 8 }}>
                <DispositionBadge value={result.disposition} />
                {result.expectedDisposition ? <Badge tone={result.expectedDisposition === result.disposition ? "ok" : "warn"} icon={result.expectedDisposition === result.disposition ? "✓" : "≠"}>{result.expectedDisposition === result.disposition ? "matches expected" : `PDF expectation: ${result.expectedDisposition}`}</Badge> : null}
                <span className="muted small">Events: {result.events.join(" → ")}</span>
              </div>
              {result.callStatus && result.callStatus !== "completed" ? <p className="small muted" style={{ marginTop: 8 }}>Call recorded as <b>{result.callStatus}</b>. No transcript was invented; a follow-up task was opened.</p> : null}
            </section>
            {result.transcript.length > 1 ? (
              <section className="card chat" aria-label="Simulated conversation"><header><h2>Conversation</h2></header>
                {result.transcript.map((t, i) => (
                  <div key={i} className={`bubble-row ${t.role}`} style={t.text === APPROVED_PRICING_RESPONSE ? { outline: "2px solid var(--accent)" } : undefined}>
                    <small>{t.role === "agent" ? "Virtual assistant" : "Caller"}{t.text === APPROVED_PRICING_RESPONSE ? " · approved pricing response (fixed wording)" : ""}</small>{t.text}
                  </div>
                ))}
              </section>
            ) : null}
            <section className="card"><header><h2>Telegram handoff preview</h2></header>
              {result.notifications.length === 0 ? <p className="muted">No designer handoff — this outcome is not forwarded (or the call has no assessment).</p> : result.notifications.map((n) => (
                <div key={n.category}><div className="row" style={{ gap: 8 }}><b>{n.category.replace(/_/g, " ")}</b><NotificationBadge value={n.status} /></div><pre className="msg">{n.preview}</pre></div>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
