"use client";

import Link from "next/link";
import { useState } from "react";

type Msg = { ok: boolean; text: string } | null;

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function CallsPanel({ agentConfigured }: { agentConfigured: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Msg>(null);
  const [synced, setSynced] = useState<Msg>(null);
  const [lastCall, setLastCall] = useState<string>("");

  async function place(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const number = String(f.get("number") ?? "").replace(/[\s-]/g, "");
    const name = String(f.get("name") ?? "");
    if (!window.confirm(`Place a real phone call to ${name} on ${number.slice(0, 3)}•••••${number.slice(-3)} now?\n\nThis rings a real phone and uses Vaani credits.`)) return;
    setBusy("place"); setPlaced(null);
    const r = await post("/api/calls/outbound", { contactNumber: number, name, consent: f.get("consent") === "on" });
    setBusy(null);
    if (r.ok) { setLastCall(r.data.callId); setPlaced({ ok: true, text: `Call requested. Call id: ${r.data.callId}. The phone should ring shortly.` }); }
    else setPlaced({ ok: false, text: r.data.detail ?? r.data.error ?? "Could not place the call." });
  }

  async function sync(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const callId = String(new FormData(e.currentTarget).get("callId") ?? "").trim();
    setBusy("sync"); setSynced(null);
    const r = await post("/api/calls/sync", { callId });
    setBusy(null);
    setSynced(r.ok ? { ok: true, text: r.data.status === "duplicate" ? "Already recorded — nothing changed." : "Call imported from Vaani." } : { ok: false, text: r.data.detail ?? r.data.error ?? "Could not import the call." });
  }

  return (
    <div className="grid two">
      <form className="card grid" onSubmit={place} aria-label="Place a test call" style={{ alignContent: "start" }}>
        <header><h2>Place a test call</h2></header>
        <p className="muted small">Vaani&apos;s agent phones the number below so you can speak to it. Outbound test calls are recorded and costed, but are never counted as enquiries and never qualified.</p>
        {!agentConfigured ? <p className="err" role="alert">No agent is configured. Run <span className="mono">npm run vaani:setup</span> and set VAANI_AGENT_ID.</p> : null}
        <label>Person&apos;s name<input name="name" required maxLength={80} placeholder="e.g. Nikhil" /></label>
        <label>Phone number (international format)<input name="number" required inputMode="tel" placeholder="+919876543210" pattern="\+?[0-9 \-]{9,20}" /></label>
        <label className="row" style={{ flexDirection: "row", gap: 8, fontWeight: 500 }}>
          <input style={{ width: "auto", minHeight: 0 }} type="checkbox" name="consent" required />This person has agreed to receive this call
        </label>
        <button className="btn" disabled={busy !== null || !agentConfigured}>{busy === "place" ? "Calling…" : "Place call"}</button>
        {placed ? <p className={placed.ok ? "ok-text" : "err"} role="status">{placed.text}</p> : null}
        <p className="muted small">Needs a phone number linked to the agent in Vaani (Settings → Telephony). Vaani&apos;s Do-Not-Disturb check stays on.</p>
      </form>

      <form className="card grid" onSubmit={sync} aria-label="Import a finished call" style={{ alignContent: "start" }}>
        <header><h2>Import a finished call</h2></header>
        <p className="muted small">Pulls the transcript, extracted answers, summary and cost from Vaani for a call id. Use it when this server has no public webhook address (local use) or a webhook was missed. Safe to repeat.</p>
        <label>Vaani call id<input name="callId" required key={lastCall} defaultValue={lastCall} placeholder="outbound-1784899978-36cec598" /></label>
        <button className="btn secondary" disabled={busy !== null}>{busy === "sync" ? "Importing…" : "Import call"}</button>
        {synced ? <p className={synced.ok ? "ok-text" : "err"} role="status">{synced.text}</p> : null}
        <p className="small"><Link href="/enquiries?scope=production">See imported calls →</Link></p>
      </form>
    </div>
  );
}
