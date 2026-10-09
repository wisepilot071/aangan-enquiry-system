"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function CostRatesForm({ initial }: { initial: { voicePerMinuteInr?: number; telephonyPerMinuteInr?: number; source?: string } }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => { const v = String(f.get(k) ?? "").trim(); return v === "" ? undefined : Number(v); };
    const body: Record<string, unknown> = {};
    const v = num("voice"), t = num("tel"), s = String(f.get("source") ?? "").trim();
    if (v !== undefined) body.voicePerMinuteInr = v;
    if (t !== undefined) body.telephonyPerMinuteInr = t;
    if (s) body.source = s;
    setBusy(true);
    const res = await fetch("/api/settings/cost-rates", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Rates saved. They apply to calls completed from now on; past records are unchanged." } : { ok: false, text: data.issues?.[0]?.message ?? "Could not save rates." });
    if (res.ok) router.refresh();
  }

  return (
    <form onSubmit={save} className="grid" style={{ gap: 12 }}>
      <div className="filters" style={{ marginBottom: 0 }}>
        <label>Voice agent rate (₹ per minute)<input name="voice" type="number" min="0" step="0.01" defaultValue={initial.voicePerMinuteInr ?? ""} placeholder="leave empty if unknown" /></label>
        <label>Telephony rate (₹ per minute)<input name="tel" type="number" min="0" step="0.01" defaultValue={initial.telephonyPerMinuteInr ?? ""} placeholder="leave empty if unknown" /></label>
        <label>Rate source (required if a rate is set)<input name="source" defaultValue={initial.source ?? ""} placeholder="e.g. provider invoice no. / contract date" /></label>
      </div>
      <p className="muted small">Only enter rates you have verified (invoice, contract or the provider&apos;s published price). Clearing everything makes new calls show &quot;unknown&quot; cost again — never ₹0.</p>
      <div className="row"><button className="btn" disabled={busy}>{busy ? "Saving…" : "Save rates"}</button>{msg ? <span className={msg.ok ? "ok-text" : "err"} role="status">{msg.text}</span> : null}</div>
    </form>
  );
}
