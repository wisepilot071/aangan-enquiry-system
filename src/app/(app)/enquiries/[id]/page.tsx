import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth-server";
import { fmtDateTime, fmtDuration, fmtInr, titleCase } from "@/lib/format";
import { one, type SP } from "@/lib/page-scope";
import { ActionButton, EnquiryActions } from "@/components/actions";
import { Badge, CallStatusBadge, CriterionBadge, DemoBadge, DispositionBadge, NotificationBadge, PriorityBadge } from "@/components/ui";
import { can } from "@/modules/authentication";
import { getEnquiryDetail } from "@/modules/enquiries/service";
import { explain } from "@/modules/qualification/explain";
import type { CriterionResult } from "@/modules/qualification/types";

export const dynamic = "force-dynamic";

export default async function EnquiryDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const user = await requireUser("view");
  const { id } = await params;
  const scope = one((await searchParams).scope);
  const d = await getEnquiryDetail(await getDb(), id, { includeTranscript: can(user.role, "view_transcript") });
  if (!d) notFound();
  const facts = d.facts as Record<string, unknown>;
  const latest = d.assessments[0];
  const criteria = (latest?.criteria ?? []) as CriterionResult[];
  const operate = can(user.role, "operate");
  const ex = explain({ disposition: d.disposition, criteria, uncertainties: (latest?.uncertainties ?? []) as string[], humanReviewReasons: d.humanReviewReasons as string[], callStatus: d.callStatus, escalationKind: d.escalationKind });
  const respSec = d.callStartedAt && d.firstResponseAt ? (d.firstResponseAt.getTime() - d.callStartedAt.getTime()) / 1000 : null;
  const transcript = (d.transcript ?? []) as { role: string; text: string }[];
  const val = (v: unknown) => (v === undefined || v === null || v === "" ? <span className="muted">Not provided</span> : String(v));

  return (
    <>
      <p className="small"><Link href={`/enquiries${scope ? `?scope=${scope}` : ""}`}>← All enquiries</Link></p>
      <div className="page-head">
        <div>
          <h1>{d.ref} {d.isDemo ? <DemoBadge /> : null}</h1>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <CallStatusBadge value={d.callStatus} /><DispositionBadge value={d.disposition} /><PriorityBadge value={d.priority} />
            {d.needsHumanReview && d.humanReviewStatus === "open" ? <Badge tone="warn" icon="👁">Needs human review</Badge> : null}
          </div>
        </div>
        <div className="muted small">Provider: {d.provider} · Call ID <span className="mono">{d.providerCallId}</span></div>
      </div>

      {d.direction === "outbound" ? <div className="banner ok" role="note"><b>↗ Outbound test call</b><span>The agent phoned this number. It is not an enquiry: it was not qualified, not handed to designers and is excluded from enquiry metrics. Cost is recorded below.</span></div> : null}
      {d.isDemo ? <div className="banner mock" role="note"><b>◈ DEMO</b><span>This is a simulated call. It is excluded from production reporting.</span></div> : null}
      {d.previous ? <div className="banner warn" role="note"><b>↻ Reconnect</b><span>Linked to the earlier dropped call <Link href={`/enquiries/${d.previous.id}`}>{d.previous.ref}</Link> — same verified number within 30 minutes. Records are linked, not merged.</span></div> : null}

      <section className={`verdict ${ex.tone}`} aria-labelledby="verdict">
        <div className="verdict-main">
          <div className="verdict-kicker">Decision</div>
          <h2 id="verdict">{ex.headline}</h2>
          <p>{ex.summary}</p>
          {d.summary ? <p className="verdict-call"><b>What happened on the call:</b> {d.summary}</p> : null}
          <p className="verdict-next"><b>What to do next:</b> {ex.nextStep}</p>
        </div>
        {ex.checks.length ? (
          <ul className="checks" aria-label="The five checks">
            {ex.checks.map((c) => (
              <li key={c.label}><CriterionBadge state={c.state} /><span><b>{c.label}.</b> {c.text}</span></li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="section" aria-labelledby="tx"><h2 id="tx">The conversation</h2>
        {!can(user.role, "view_transcript") ? <div className="card muted">Transcripts are restricted to operators and admins.</div>
          : !d.transcriptAvailable ? <div className="card muted">No transcript exists for this call{d.callStatus !== "completed" ? ` (${titleCase(d.callStatus).toLowerCase()})` : ""}. Nothing is invented.</div>
            : <div className="card chat" aria-label="Call transcript">{transcript.map((t, i) => <div key={i} className={`bubble-row ${t.role}`}><small>{t.role === "agent" ? "Virtual assistant" : "Caller"}</small>{t.text}</div>)}</div>}
      </section>

      <div className="grid two">
        <section className="card" aria-labelledby="info"><header><h2 id="info">Enquiry details</h2></header>
          <dl className="kv">
            <dt>Caller</dt><dd>{val(d.callerName)}</dd>
            <dt>Phone (call metadata)</dt><dd className="mono">{val(d.callerPhone)}</dd>
            <dt>Caller type</dt><dd>{titleCase(d.callerType)}</dd>
            <dt>Project</dt><dd>{val(d.projectCategory ? `${titleCase(d.projectCategory)}${d.propertyType ? ` · ${titleCase(d.propertyType)}` : ""}` : null)}</dd>
            <dt>Location</dt><dd>{val(d.locationText)}</dd>
            <dt>Carpet area</dt><dd>{d.carpetAreaSqft ? `${d.carpetAreaSqft} sq ft` : val(null)}</dd>
            <dt>Scope</dt><dd>{val([facts.scopeKind, facts.roomCount ? `${facts.roomCount} room(s)` : null].filter(Boolean).map((x) => titleCase(String(x))).join(", "))}</dd>
            <dt>Timeline</dt><dd>{val(facts.needByWeeks !== undefined ? `Needed in ~${Math.round(Number(facts.needByWeeks))} weeks` : facts.timelineFlexible ? "Flexible" : facts.desiredStartWeeks !== undefined ? `Start in ~${Math.round(Number(facts.desiredStartWeeks))} weeks` : null)}</dd>
            <dt>Site readiness</dt><dd>{val(facts.siteAvailableInWeeks === undefined ? null : Number(facts.siteAvailableInWeeks) === 0 ? "Available now" : `In ~${facts.siteAvailableInWeeks} weeks`)}</dd>
            <dt>Decision-maker</dt><dd>{titleCase(String(facts.decisionMaker ?? "unknown"))}</dd>
            <dt>Budget</dt><dd>{facts.statedBudgetMaxInr ? `Volunteered: up to ${fmtInr(Number(facts.statedBudgetMaxInr))}` : "Not disclosed (never probed)"}</dd>
            <dt>Consultation</dt><dd>{d.consultationStatus === "confirmed" ? <><Badge tone="ok" icon="✓">Scheduled{d.consultationAt ? ` · ${fmtDateTime(d.consultationAt)}` : ""}</Badge>{d.consultationNote ? <span className="sub">{d.consultationNote}</span> : null}</> : d.consultationStatus === "requested" ? <Badge tone="warn" icon="…">Requested — NOT yet booked</Badge> : "Not requested"}</dd>
            <dt>Referral</dt><dd>{val(facts.referralSource)}</dd>
            <dt>Summary</dt><dd>{val(d.summary)}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="timing"><header><h2 id="timing">Call timing</h2></header>
          <dl className="kv">
            <dt>Call started</dt><dd>{fmtDateTime(d.callStartedAt)}</dd>
            <dt>First agent response</dt><dd>{d.firstResponseAt ? <>{fmtDateTime(d.firstResponseAt)} <span className="muted">({fmtDuration(respSec)} after start{respSec !== null && respSec <= 300 ? " · within 5 min" : ""})</span></> : <span className="muted">Not measurable (provider sent no response timestamp)</span>}</dd>
            <dt>Call ended</dt><dd>{fmtDateTime(d.callEndedAt)} {d.durationSec ? <span className="muted">· {fmtDuration(d.durationSec)}</span> : <span className="muted">· length not reported</span>}</dd>
            <dt>Record completed</dt><dd>{fmtDateTime(d.recordCompletedAt)}</dd>
            <dt>Designer notified</dt><dd>{d.notifiedAt ? fmtDateTime(d.notifiedAt) : <span className="muted">Not delivered</span>}</dd>
            <dt>Rule version</dt><dd className="mono">{d.ruleVersion ?? "—"}</dd>
          </dl>
        </section>
      </div>

      <section className="section" aria-labelledby="qual"><h2 id="qual">The rules, in detail</h2>
        <p>The evidence behind each of Nikhil&apos;s five checks, with the rule code. Decided by the rules engine, not by the voice model.</p>
        {d.disposition === "ESCALATED" ? <div className="banner bad" role="note"><b>▲ Sales qualification bypassed</b><span>This is an escalation to a human, not a sales lead. It was not forwarded to designers as a lead.</span></div> : null}
        {criteria.length ? (
          <div className="card">
            {criteria.map((c) => (
              <div className="crit" key={c.id}>
                <b>{c.number}</b>
                <div><div className="row" style={{ gap: 8 }}><b>{titleCase(c.id)}</b><CriterionBadge state={c.state} /><span className="mono muted">{c.reasonCode}</span></div><div className="small">{c.evidence}</div></div>
              </div>
            ))}
            {((latest?.uncertainties ?? []) as string[]).length ? <p className="small" style={{ marginTop: 10 }}><b>Uncertainties for the designer:</b> {(latest!.uncertainties as string[]).join(" | ")}</p> : null}
            {(d.humanReviewReasons as string[]).length ? <p className="small" style={{ marginTop: 6 }}><b>Human review:</b> {(d.humanReviewReasons as string[]).join(" | ")} <Badge tone={d.humanReviewStatus === "resolved" ? "ok" : "warn"}>{d.humanReviewStatus}</Badge></p> : null}
          </div>
        ) : <div className="card muted">No qualification yet — {d.callStatus === "completed" ? "no assessment was stored." : `the call is ${titleCase(d.callStatus).toLowerCase()} and has no transcript.`}</div>}
      </section>

      <section className="section" aria-labelledby="notif"><h2 id="notif">Notifications</h2>
        <div className="grid">
          {d.notifications.length === 0 ? <div className="card muted">No notification was created{d.disposition && d.disposition !== "QUALIFIED" && d.disposition !== "ESCALATED" ? " — this enquiry is not forwarded to designers by design." : "."}</div> : null}
          {d.notifications.map((n) => (
            <div className="card" key={n.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row" style={{ gap: 8 }}><b>{titleCase(n.category)}</b><NotificationBadge value={n.status} /><span className="muted small">attempts: {n.attempts}{n.errorCategory ? ` · ${n.errorCategory}` : ""}</span></div>
                {operate && (n.status === "failed" || n.status === "unavailable") ? <ActionButton url={`/api/notifications/${n.id}/retry`} label="Retry delivery" done="Retry attempted." /> : null}
              </div>
              {n.status === "mock_sent" ? <p className="small muted" style={{ marginTop: 6 }}>Simulated: this message was NOT sent to Telegram. It is a preview of what a designer would receive.</p> : null}
              <pre className="msg">{n.messagePreview}</pre>
            </div>
          ))}
        </div>
      </section>

      {d.tasks.length ? (
        <section className="section" aria-labelledby="tasks"><h2 id="tasks">Follow-up tasks</h2>
          <div className="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Note</th><th /></tr></thead><tbody>
            {d.tasks.map((t) => (
              <tr key={t.id}><td>{titleCase(t.kind)}</td><td>{t.status === "open" ? <Badge tone="warn" icon="◔">Open</Badge> : <Badge tone="ok" icon="✓">Done · {t.completedBy}</Badge>}</td><td>{t.note}</td>
                <td>{operate && t.status === "open" ? <ActionButton url={`/api/tasks/${t.id}/complete`} label="Mark done" /> : null}</td></tr>
            ))}</tbody></table></div>
        </section>
      ) : null}

      <section className="section" aria-labelledby="costs"><h2 id="costs">Cost records</h2>
        {d.costs.length === 0 ? <div className="card muted">No cost record (the call has not completed).</div> : (
          <div className="table-wrap"><table><thead><tr><th>Category</th><th>Basis</th><th>Amount</th><th>Quantity</th><th>Rate source</th></tr></thead><tbody>
            {d.costs.map((c) => (
              <tr key={c.id}><td>{titleCase(c.category)}</td>
                <td>{c.basis === "actual" ? <Badge tone="ok" icon="✓">Actual</Badge> : c.basis === "estimated" ? <Badge tone="info" icon="≈">Estimated</Badge> : <Badge tone="neutral" icon="?">Unknown</Badge>}</td>
                <td>{c.amount === null ? <span className="muted">Unknown (not ₹0)</span> : `${c.currency === "INR" ? fmtInr(Number(c.amount)) : `${c.amount} ${c.currency}`}`}</td>
                <td>{c.quantity ? `${Number(c.quantity)} ${c.unit ?? ""}` : "—"}</td><td className="small">{c.rateSource}</td></tr>
            ))}</tbody></table></div>
        )}
      </section>


      {operate ? (
        <section className="section" aria-labelledby="act"><h2 id="act">Operator actions</h2>
          <div className="card"><EnquiryActions id={d.id} review={d.humanReviewStatus} consultation={d.consultationStatus} conversion={d.conversionStatus} disposition={d.disposition}
            consultationAtLocal={d.consultationAt ? new Date(d.consultationAt.getTime() + 330 * 60_000).toISOString().slice(0, 16) : undefined} consultationNote={d.consultationNote ?? undefined} /></div>
        </section>
      ) : null}

      <div className="grid two section">
        <section className="card" aria-labelledby="ev"><header><h2 id="ev">Provider event history</h2></header>
          {d.events.length === 0 ? <p className="muted">No events.</p> : <ul className="timeline">{d.events.map((e) => <li key={e.id}><b>{e.eventType}</b> <Badge tone={e.status === "processed" ? "ok" : e.status === "failed" || e.status === "rejected" ? "bad" : "neutral"}>{e.status}</Badge> <span className="muted small">{fmtDateTime(e.receivedAt)}{e.attempts > 1 ? ` · received ${e.attempts}×` : ""}{e.errorCategory ? ` · ${e.errorCategory}` : ""}</span></li>)}</ul>}
        </section>
        <section className="card" aria-labelledby="au"><header><h2 id="au">Audit trail</h2></header>
          <ul className="timeline">{d.audit.map((a) => <li key={a.id}><b>{a.action}</b> <span className="muted small">{a.actor} · {fmtDateTime(a.at)}</span></li>)}</ul>
        </section>
      </div>
    </>
  );
}
