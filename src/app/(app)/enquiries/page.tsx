import Link from "next/link";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth-server";
import { fmtDateTime, maskPhone, titleCase } from "@/lib/format";
import { one, readScope, type SP } from "@/lib/page-scope";
import { Badge, CallStatusBadge, DemoBadge, DispositionBadge, Empty, NotificationBadge, PriorityBadge } from "@/components/ui";
import { listEnquiries } from "@/modules/analytics/queries";
import { enquiryRef } from "@/modules/notifications/format";

export const dynamic = "force-dynamic";

const DISPOSITIONS = ["QUALIFIED", "CLOSED_NOT_FORWARDED", "DECLINED", "HUMAN_REVIEW", "NEEDS_CLARIFICATION", "ESCALATED", "NONE"];
const CALL_STATUS = ["completed", "in_progress", "missed", "disconnected", "failed"];
const NOTE_STATUS = ["sent", "mock_sent", "failed", "unavailable", "pending"];

export default async function EnquiriesPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser("view");
  const sp = await searchParams;
  const { scope, range, from, to } = readScope(sp);
  const g = (k: string) => one(sp[k]) || undefined;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const sort = g("sort") === "oldest" || g("sort") === "priority" ? (g("sort") as "oldest" | "priority") : "newest";
  const res = await listEnquiries(await getDb(), {
    scope, ...range, q: g("q"), disposition: g("disposition"), callStatus: g("callStatus"), notificationStatus: g("notificationStatus"),
    review: g("review") === "yes" ? "yes" : g("review") === "no" ? "no" : undefined, projectCategory: g("projectCategory"), location: g("location"), sort, page,
  });
  const qs = (over: Record<string, string | number>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) { const x = one(v); if (x) p.set(k, x); }
    p.set("scope", scope);
    for (const [k, v] of Object.entries(over)) p.set(k, String(v));
    return `/enquiries?${p.toString()}`;
  };
  const filtered = ["q", "disposition", "callStatus", "notificationStatus", "review", "projectCategory", "location", "from", "to"].some((k) => g(k));

  return (
    <>
      <div className="page-head">
        <div><h1>Enquiries {scope === "demo" ? <DemoBadge /> : null}</h1><p>{res.total} enquir{res.total === 1 ? "y" : "ies"}{filtered ? " match the filters" : ""}. Phone calls only.</p></div>
      </div>

      <form method="get" className="filters card" aria-label="Filter enquiries">
        <input type="hidden" name="scope" value={scope} />
        <label>Search<input name="q" defaultValue={g("q")} placeholder="Name, phone, ID, area" /></label>
        <label>Qualification<select name="disposition" defaultValue={g("disposition") ?? ""}><option value="">Any</option>{DISPOSITIONS.map((d) => <option key={d} value={d}>{d === "NONE" ? "Not assessed" : titleCase(d)}</option>)}</select></label>
        <label>Call status<select name="callStatus" defaultValue={g("callStatus") ?? ""}><option value="">Any</option>{CALL_STATUS.map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}</select></label>
        <label>Notification<select name="notificationStatus" defaultValue={g("notificationStatus") ?? ""}><option value="">Any</option>{NOTE_STATUS.map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}</select></label>
        <label>Human review<select name="review" defaultValue={g("review") ?? ""}><option value="">Any</option><option value="yes">Needs review</option><option value="no">No review needed</option></select></label>
        <label>Project type<select name="projectCategory" defaultValue={g("projectCategory") ?? ""}><option value="">Any</option><option value="residential">Residential</option><option value="commercial">Commercial</option></select></label>
        <label>Location<input name="location" defaultValue={g("location")} placeholder="e.g. Baner" /></label>
        <label>From<input type="date" name="from" defaultValue={from ?? ""} /></label>
        <label>To<input type="date" name="to" defaultValue={to ?? ""} /></label>
        <label>Sort<select name="sort" defaultValue={sort}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="priority">Priority</option></select></label>
        <div className="row"><button className="btn">Apply</button>{filtered ? <Link className="btn secondary" href={`/enquiries?scope=${scope}`}>Clear</Link> : null}</div>
      </form>

      {res.items.length === 0 ? (
        <div className="card"><Empty title={filtered ? "No enquiries match these filters" : "No enquiries yet"}>
          {filtered ? "Try clearing a filter." : scope === "demo" ? <>Run a simulated call in <Link href="/simulator?scope=demo">the call simulator</Link>.</> : "Enquiries appear after the first incoming call."}
        </Empty></div>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Enquiries</caption>
            <thead><tr><th>Enquiry</th><th>Caller</th><th>Project</th><th>Call</th><th>Qualification</th><th>Handoff</th></tr></thead>
            <tbody>
              {res.items.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/enquiries/${e.id}?scope=${scope}`}><b>{enquiryRef(e.seq)}</b></Link>{e.isDemo ? <> <DemoBadge /></> : null}{e.direction === "outbound" ? <> <Badge tone="info" icon="↗">Outbound test</Badge></> : null}<span className="sub">{fmtDateTime(e.callStartedAt ?? e.createdAt)}</span></td>
                  <td>{e.callerName ?? <span className="muted">Not provided</span>}<span className="sub mono">{maskPhone(e.callerPhone)}</span></td>
                  <td>{e.projectCategory ? titleCase(e.projectCategory) : "—"}{e.propertyType ? ` · ${titleCase(e.propertyType)}` : ""}<span className="sub">{e.locationText ?? "Location not captured"}</span></td>
                  <td><CallStatusBadge value={e.callStatus} /></td>
                  <td><div className="row" style={{ gap: 6 }}><DispositionBadge value={e.disposition} />{e.priority !== "normal" ? <PriorityBadge value={e.priority} /> : null}{e.needsHumanReview ? <span className="badge warn"><span aria-hidden="true">👁</span>Review</span> : null}</div></td>
                  <td>{e.notifications.length ? <div className="row" style={{ gap: 4 }}>{e.notifications.map((n) => <NotificationBadge key={n.category} value={n.status} />)}</div> : <span className="muted small">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className="pager" aria-label="Pagination">
        <span className="muted small">Page {res.page} of {res.pages} · {res.total} total</span>
        <span className="row">
          {res.page > 1 ? <Link className="btn secondary small" href={qs({ page: res.page - 1 })}>← Previous</Link> : null}
          {res.page < res.pages ? <Link className="btn secondary small" href={qs({ page: res.page + 1 })}>Next →</Link> : null}
        </span>
      </nav>
    </>
  );
}
