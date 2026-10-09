import Link from "next/link";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth-server";
import { fmtDateTime, maskPhone, titleCase } from "@/lib/format";
import { readScope, type SP } from "@/lib/page-scope";
import { ActionButton } from "@/components/actions";
import { Badge, DemoBadge, Empty, PriorityBadge } from "@/components/ui";
import { getUrgentQueue } from "@/modules/analytics/queries";
import { can } from "@/modules/authentication";
import { enquiryRef } from "@/modules/notifications/format";

export const dynamic = "force-dynamic";

const KIND: Record<string, { label: string; tone: "bad" | "warn" | "info" | "neutral"; icon: string; why: string }> = {
  complaint: { label: "Existing-client complaint", tone: "bad", icon: "▲▲", why: "Needs a senior person — no callback time was promised." },
  human_requested: { label: "Caller asked for a person", tone: "bad", icon: "▲", why: "Caller requested a human." },
  failed_handoff: { label: "Failed designer handoff", tone: "bad", icon: "✕", why: "Telegram did not deliver — hand off manually or retry." },
  frustrated_followup: { label: "Frustrated repeat caller", tone: "warn", icon: "▲", why: "An earlier enquiry was not followed up." },
  missed_call: { label: "Missed call", tone: "warn", icon: "☏", why: "No transcript. No automatic callback is made." },
  dropped_call: { label: "Dropped call", tone: "info", icon: "⌁", why: "Disconnected before completion." },
};

export default async function UrgentPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser("view");
  const { scope } = readScope(await searchParams);
  const tasks = await getUrgentQueue(await getDb(), scope);
  const open = tasks.filter((t) => t.status === "open");
  const done = tasks.filter((t) => t.status !== "open");
  const operate = can(user.role, "operate");

  const table = (rows: typeof tasks, isOpen: boolean) => (
    <div className="table-wrap"><table>
      <caption className="sr-only">{isOpen ? "Open follow-ups" : "Completed follow-ups"}</caption>
      <thead><tr><th>Type</th><th>Enquiry</th><th>Caller</th><th>Detail</th><th>Raised</th>{isOpen && operate ? <th /> : <th>Closed</th>}</tr></thead>
      <tbody>{rows.map((t) => {
        const k = KIND[t.kind] ?? { label: titleCase(t.kind), tone: "neutral" as const, icon: "·", why: "" };
        return (
          <tr key={t.id}>
            <td><Badge tone={k.tone} icon={k.icon}>{k.label}</Badge>{t.priority !== "normal" ? <div style={{ marginTop: 4 }}><PriorityBadge value={t.priority} /></div> : null}</td>
            <td><Link href={`/enquiries/${t.enquiryId}?scope=${scope}`}><b>{enquiryRef(t.seq)}</b></Link>{t.isDemo ? <> <DemoBadge /></> : null}</td>
            <td>{t.callerName ?? <span className="muted">Not provided</span>}<span className="sub mono">{maskPhone(t.callerPhone)}</span><span className="sub">{t.locationText ?? ""}</span></td>
            <td>{t.note}<span className="sub">{k.why}</span></td>
            <td className="nowrap">{fmtDateTime(t.createdAt)}</td>
            <td>{isOpen ? (operate ? <ActionButton url={`/api/tasks/${t.id}/complete`} label="Mark done" /> : null) : <span className="small muted">{t.completedBy} · {fmtDateTime(t.completedAt)}</span>}</td>
          </tr>
        );
      })}</tbody></table></div>
  );

  return (
    <>
      <div className="page-head"><div><h1>Urgent queue {scope === "demo" ? <DemoBadge /> : null}</h1>
        <p>Complaints, human requests, flagged callers, failed handoffs and missed or dropped calls that need a person. Nothing here is followed up automatically.</p></div></div>
      {open.length === 0 ? <div className="card"><Empty title="Nothing waiting">All follow-ups are done. New escalations, missed calls and failed handoffs will appear here.</Empty></div> : table(open, true)}
      {done.length ? <section className="section"><h2>Completed</h2><p>Most recent {done.length}.</p>{table(done, false)}</section> : null}
    </>
  );
}
