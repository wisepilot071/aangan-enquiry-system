import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth-server";
import { fmtDuration, fmtInr, fmtPct } from "@/lib/format";
import { HELP } from "@/lib/metric-help";
import { readScope, type SP } from "@/lib/page-scope";
import { BarChart, Badge, DemoBadge, Empty, Kpi } from "@/components/ui";
import { RangeFilter } from "@/components/range-filter";
import { getDailySeries, getMetrics } from "@/modules/analytics/queries";

export const dynamic = "force-dynamic";

export default async function Overview({ searchParams }: { searchParams: Promise<SP> }) {
  await requireUser("view");
  const sp = await searchParams;
  const { scope, range, from, to } = readScope(sp);
  const db = await getDb();
  const [m, daily] = await Promise.all([getMetrics(db, scope, range), getDailySeries(db, scope, range)]);
  const rt = m.response;
  const empty = m.calls.total === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview {scope === "demo" ? <DemoBadge /> : null}</h1>
          <p>{scope === "demo" ? "Simulated calls only — these numbers describe the demo, not the studio." : "Incoming phone calls handled by the AI front desk."} Every figure is computed from stored records; hover ⓘ for its definition.</p>
        </div>
        <RangeFilter scope={scope} from={from} to={to} action="/" />
      </div>

      {empty ? (
        <div className="card"><Empty title="No calls in this period">
          {scope === "demo" ? <>Run a simulated call from <a href="/simulator?scope=demo">the call simulator</a> to see metrics appear.</> : <>Calls will appear here once the voice provider is connected and a call is received.</>}
        </Empty></div>
      ) : null}

      <section className="section" aria-labelledby="calls"><h2 id="calls">Calls</h2>
        <div className="grid kpis">
          <Kpi label="Incoming calls" value={m.calls.total} help={HELP.totalCalls} />
          <Kpi label="Successfully handled" value={m.calls.handled} sub={`${m.calls.completed} completed`} help={HELP.handled} />
          <Kpi label="Missed / failed" value={m.calls.missed + m.calls.failed} sub={`${m.calls.missed} missed · ${m.calls.failed} failed`} help={HELP.missedFailed} />
          <Kpi label="Disconnected" value={m.calls.disconnected} sub={m.calls.inProgress ? `${m.calls.inProgress} stale in-progress` : "caller dropped mid-call"} />
        </div>
      </section>

      <section className="section" aria-labelledby="qual"><h2 id="qual">Qualification</h2>
        <p>Decided by Nikhil&apos;s five-criteria rubric — not by the language model.</p>
        <div className="grid kpis">
          <Kpi label="Qualified" value={m.qualification.qualified} help={HELP.qualified} />
          <Kpi label="Unqualified" value={m.qualification.unqualified} help={HELP.unqualified} />
          <Kpi label="Qualified rate" na={m.qualification.qualifiedRate.value === null} value={fmtPct(m.qualification.qualifiedRate.value)}
            sub={`${m.qualification.qualifiedRate.num} of ${m.qualification.qualifiedRate.den} decided enquiries`} help={HELP.qualifiedRate} />
          <Kpi label="Needs human review" value={m.qualification.humanReviewOpen} sub={`${m.qualification.needsClarificationOrReview} unresolved`} help={HELP.review} />
          <Kpi label="Urgent complaints" value={m.qualification.urgent} sub={`${m.qualification.escalated} escalations`} help={HELP.urgent} />
        </div>
        {daily.length ? (
          <div className="card" style={{ marginTop: 14 }}>
            <header><h3>Calls per day</h3><span className="muted small">IST</span></header>
            <BarChart data={daily.map((d) => ({ label: d.day, segments: [
              { name: "Qualified", value: d.qualified, className: "q" }, { name: "Unqualified", value: d.unqualified, className: "u" }, { name: "Other / unassessed", value: d.other, className: "o" },
            ] }))} />
            <div className="legend"><span><i style={{ background: "var(--ok)" }} />Qualified</span><span><i style={{ background: "var(--ink-2)" }} />Unqualified</span><span><i style={{ background: "var(--warn)" }} />Other / unassessed</span></div>
          </div>
        ) : null}
      </section>

      <section className="section" aria-labelledby="speed"><h2 id="speed">Response speed</h2>
        <p>Target: every incoming call answered within five minutes. Measured only where the provider reports both timestamps.</p>
        <div className="grid kpis">
          <Kpi label="Avg first response" na={rt.firstResponse.avg === null} value={fmtDuration(rt.firstResponse.avg)} sub={`median ${fmtDuration(rt.firstResponse.median)} · n=${rt.firstResponse.n}`} help={HELP.firstResponse} />
          <Kpi label="Answered ≤ 5 min (measured)" na={rt.within5MinMeasured.value === null} value={fmtPct(rt.within5MinMeasured.value)} sub={`${rt.within5MinMeasured.num} of ${rt.within5MinMeasured.den} measurable calls`} help={HELP.fiveMin} />
          <Kpi label="Answered ≤ 5 min (strict)" na={rt.within5MinStrict.value === null} value={fmtPct(rt.within5MinStrict.value)} sub={`${rt.within5MinStrict.num} of ${rt.within5MinStrict.den} · missed/failed count against`} help={HELP.fiveMin} />
          <Kpi label="Unmeasurable" value={rt.unmeasurable} sub={`${rt.noResponseAtAll} with no response at all`} help="Calls with no provider response timestamp. Excluded from the measured rate, never assumed compliant." />
        </div>
        <div className="grid kpis" style={{ marginTop: 14 }}>
          <Kpi label="To completed record" na={!rt.timeToCompletedRecord.n} value={fmtDuration(rt.timeToCompletedRecord.avg)} sub={`n=${rt.timeToCompletedRecord.n} · call start → record saved`} />
          <Kpi label="To qualification" na={!rt.timeToQualification.n} value={fmtDuration(rt.timeToQualification.avg)} sub={`n=${rt.timeToQualification.n}`} />
          <Kpi label="To designer notification" na={!rt.timeToDesignerNotification.n} value={fmtDuration(rt.timeToDesignerNotification.avg)} sub={`n=${rt.timeToDesignerNotification.n} · real deliveries only`} />
        </div>
      </section>

      <section className="section" aria-labelledby="hand"><h2 id="hand">Designer handoff (Telegram)</h2>
        <div className="grid kpis">
          <Kpi label="Handoff success rate" na={m.handoff.successRate.value === null} value={fmtPct(m.handoff.successRate.value)}
            sub={m.handoff.successRate.den ? `${m.handoff.successRate.num} of ${m.handoff.successRate.den} attempts` : m.handoff.simulated ? "only simulated deliveries — nothing real sent" : "no attempts yet"} help={HELP.handoff} />
          <Kpi label="Delivered" value={m.handoff.sent} />
          <Kpi label="Failed / unavailable" value={m.handoff.failed + m.handoff.unavailable} sub={`${m.handoff.failed} failed · ${m.handoff.unavailable} unavailable`} />
          <Kpi label="Simulated (demo)" value={m.handoff.simulated} sub="previews only — not delivered" />
        </div>
      </section>

      <section className="section" aria-labelledby="cost"><h2 id="cost">Cost</h2>
        <p>Actual and estimated figures are never combined. <a href={`/costs?scope=${scope}`}>Full cost breakdown →</a></p>
        <div className="grid kpis">
          <Kpi label="Actual (provider-reported)" na={!m.cost.callsWithActual} value={m.cost.callsWithActual ? fmtInr(m.cost.actualInr) : "Not available"} sub={`${m.cost.callsWithActual} calls`} help={HELP.actualCost} />
          <Kpi label="Estimated (verified rate)" na={!m.cost.callsWithEstimate} value={m.cost.callsWithEstimate ? fmtInr(m.cost.estimatedInr) : "Not available"} sub={`${m.cost.callsWithEstimate} calls`} help={HELP.estimatedCost} />
          <Kpi label="Unknown cost" value={m.cost.unknownCount} sub="records — not counted as ₹0" help={HELP.unknownCost} />
          <Kpi label="Cost per qualified lead" na={m.cost.perQualifiedLead.actual === null && m.cost.perQualifiedLead.estimated === null} value={m.cost.perQualifiedLead.actual !== null ? `${fmtInr(m.cost.perQualifiedLead.actual)} actual` : m.cost.perQualifiedLead.estimated !== null ? `${fmtInr(m.cost.perQualifiedLead.estimated)} est.` : "N/A"} sub={m.qualification.qualified ? `${m.qualification.qualified} qualified leads` : "no qualified leads"} help={HELP.perQualified} />
        </div>
      </section>

      <section className="section" aria-labelledby="out"><h2 id="out">Outcomes</h2>
        <div className="grid kpis">
          <Kpi label="Consultations requested" value={m.outcomes.consultationRequested} sub="NOT booked until confirmed" help={HELP.consultation} />
          <Kpi label="Consultations confirmed" value={m.outcomes.consultationConfirmed} sub="confirmed by a person" help={HELP.consultation} />
          <Kpi label="Conversion rate" na={m.outcomes.conversionRate.value === null} value={m.outcomes.conversionRate.value === null ? "Not yet recorded" : fmtPct(m.outcomes.conversionRate.value)}
            sub={`${m.outcomes.converted} converted · ${m.outcomes.lost} lost`} help={HELP.conversion} />
          <Kpi label="Revenue influenced" na={m.outcomes.revenueInfluencedInr === null} value={m.outcomes.revenueInfluencedInr === null ? "Not yet recorded" : fmtInr(m.outcomes.revenueInfluencedInr)} help={HELP.revenue} />
        </div>
        <p className="muted small" style={{ marginTop: 10 }}><Badge tone="info" icon="ⓘ">Honest empty states</Badge> Conversion and revenue appear only after an operator records an outcome on an enquiry.</p>
      </section>
    </>
  );
}
