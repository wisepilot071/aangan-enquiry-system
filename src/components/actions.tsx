"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, message: "Saved." };
    const detail = data.issues?.[0]?.message ?? data.detail ?? data.error ?? "request failed";
    return { ok: false, message: `Could not save: ${String(detail).replace(/_/g, " ")}` };
  } catch {
    return { ok: false, message: "Network error — please try again." };
  }
}

export function ActionButton({ url, label, confirm, done }: { url: string; label: string; confirm?: string; done?: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; msg?: string; ok?: boolean }>({ busy: false });
  return (
    <span className="row" style={{ gap: 8 }}>
      <button className="btn secondary small" disabled={state.busy} onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setState({ busy: true });
        const r = await call(url, "POST");
        setState({ busy: false, msg: r.ok ? done ?? "Done." : r.message, ok: r.ok });
        if (r.ok) router.refresh();
      }}>{state.busy ? "Working…" : label}</button>
      {state.msg ? <span className={state.ok ? "ok-text" : "err"} role="status">{state.msg}</span> : null}
    </span>
  );
}

export function EnquiryActions({ id, review, consultation, conversion, disposition }: { id: string; review: string; consultation: string; conversion: string; disposition: string | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    const r = await call(`/api/enquiries/${id}`, "PATCH", body);
    setBusy(false);
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) router.refresh();
  }

  return (
    <div className="grid" style={{ gap: 14 }}>
      {review === "open" ? <div><button className="btn small" disabled={busy} onClick={() => patch({ humanReviewStatus: "resolved" })}>Mark human review resolved</button></div> : null}

      <form className="row" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get("c"); patch({ consultationStatus: v }, v === "confirmed" ? "Confirm only if a person has actually booked this consultation with the caller. Continue?" : undefined); }}>
        <label>Consultation<select name="c" defaultValue={consultation}><option value="none">Not requested</option><option value="requested">Requested (not booked)</option><option value="confirmed">Confirmed (booked by a person)</option></select></label>
        <button className="btn secondary small" disabled={busy} style={{ alignSelf: "end" }}>Update</button>
      </form>

      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const status = String(f.get("s"));
        const value = String(f.get("v") ?? "").trim();
        patch({ conversionStatus: status, ...(status === "converted" && value ? { projectValueInr: Number(value) } : {}) });
      }}>
        <label>Outcome<select name="s" defaultValue={conversion}><option value="unknown">Not yet recorded</option><option value="in_progress">In progress</option><option value="converted">Converted</option><option value="lost">Lost</option></select></label>
        <label>Project value (₹, converted only)<input name="v" type="number" min="1" step="1" placeholder="actual signed value" /></label>
        <button className="btn secondary small" disabled={busy} style={{ alignSelf: "end" }}>Record</button>
      </form>

      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        patch({ disposition: f.get("d"), reason: f.get("r") }, "Manually changing the qualification outcome is recorded in the audit log. Continue?");
      }}>
        <label>Override outcome<select name="d" defaultValue={disposition ?? "HUMAN_REVIEW"}>
          {["QUALIFIED", "CLOSED_NOT_FORWARDED", "DECLINED", "HUMAN_REVIEW", "ESCALATED"].map((d) => <option key={d} value={d}>{d.replace(/_/g, " ").toLowerCase()}</option>)}
        </select></label>
        <label>Reason (required)<input name="r" required minLength={3} maxLength={300} placeholder="Why is this being changed?" /></label>
        <button className="btn secondary small" disabled={busy} style={{ alignSelf: "end" }}>Change</button>
      </form>
      <p className="muted small">An override changes the record only; it does not send a designer handoff.</p>
      {msg ? <p className={msg.ok ? "ok-text" : "err"} role="status">{msg.text}</p> : null}
    </div>
  );
}
