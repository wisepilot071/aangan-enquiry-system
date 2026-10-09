import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth-server";
import { fmtInr, fmtPct, titleCase } from "@/lib/format";
import { HELP } from "@/lib/metric-help";
import { readScope, type SP } from "@/lib/page-scope";
import { CostRatesForm } from "@/components/cost-rates-form";
import { RangeFilter } from "@/components/range-filter";
import { Badge, DemoBadge, Empty, Kpi } from "@/components/ui";
import { getMetrics } from "@/modules/analytics/queries";
import { can } from "@/modules/authentication";
import { getRates } from "@/modules/costs";

export const dynamic = "force-dynamic";

export default async function CostsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser("view");
  const { scope, range, from, to } = readScope(await searchParams);
  const db = await getDb();
  const [m, rates] = await Promise.all([getMetrics(db, scope, range), getRates(db)]);
  const c = m.cost;
  const total = c.callsWithActual + c.callsWithEstimate + c.unknownCount;
  const period = from || to ? `${from ?? "start"} → ${to ?? "today"}` : "All time";
  const rows = (o: Record<string, { actual: number; estimated: number; unknown: number }>) => Object.entries(o);
  const hasRates = rates.voicePerMinuteInr !== undefined || rates.telephonyPerMinuteInr !== undefined;

  return (
    <>
      <div className="page-head">
        <div><h1>Costs {scope === "demo" ? <DemoBadge /> : null}</h1>
          <p>Period: <b>{period}</b>. Actual, estimated and unknown costs are always kept apart. An unknown cost is never treated as zero, and no provider prices are assumed.</p></div>
        <RangeFilter scope={scope} from={from} to={to} action="/costs" />
      </div>

      {total === 0 ? <div className="card"><Empty title="No cost records in this period">Costs are recorded when a call completes.</Empty></div> : (
        <>
          <div className="grid kpis">
            <Kpi label="Actual · provider-reported" na={!c.callsWithActual} value={c.callsWithActual ? fmtInr(c.actualInr) : "None reported"} sub={`${c.callsWithActual} calls`} help={HELP.actualCost} />
            <Kpi label="Estimated · verified rate" na={!c.callsWithEstimate} value={c.callsWithEstimate ? fmtInr(c.estimatedInr) : "None"} sub={`${c.callsWithEstimate} calls`} help={HELP.estimatedCost} />
            <Kpi label="Unknown cost" value={c.unknownCount} sub="records — excluded from every total" help={HELP.unknownCost} />
            <Kpi label="Cost per call (actual)" na={c.perCall.actual === null} value={fmtInr(c.perCall.actual)} sub={`over ${c.callsWithActual} calls with actual cost`} help={HELP.perCall} />
            <Kpi label="Cost per call (estimated)" na={c.perCall.estimated === null} value={fmtInr(c.perCall.estimated)} sub={`over ${c.callsWithEstimate} calls with an estimate`} help={HELP.perCall} />
            <Kpi label="Per qualified lead (actual)" na={c.perQualifiedLead.actual === null} value={fmtInr(c.perQualifiedLead.actual)} sub={m.qualification.qualified ? `${m.qualification.qualified} qualified leads` : "no qualified leads"} help={HELP.perQualified} />
            <Kpi label="Per qualified lead (estimated)" na={c.perQualifiedLead.estimated === null} value={fmtInr(c.perQualifiedLead.estimated)} sub={m.qualification.qualified ? `${m.qualification.qualified} qualified leads` : "no qualified leads"} help={HELP.perQualified} />
            <Kpi label="Per known conversion" na value={m.outcomes.converted ? "Needs cost data" : "Not yet recorded"} sub={`${m.outcomes.converted} recorded conversions · ${fmtPct(m.outcomes.conversionRate.value)} rate`} help={HELP.conversion} />
          </div>
          {Object.keys(c.otherCurrencies).length ? <div className="banner warn" style={{ marginTop: 14 }} role="note"><b>Other currencies</b><span>{Object.entries(c.otherCurrencies).map(([k, v]) => `${v} ${k}`).join(", ")} — reported by the provider and not converted or added to ₹ totals.</span></div> : null}

          <div className="grid two section">
            {([["By provider", c.byProvider], ["By cost category", c.byCategory]] as const).map(([title, data]) => (
              <section className="card" key={title}><header><h2>{title}</h2></header>
                <div className="table-wrap"><table><thead><tr><th>{title.replace("By ", "")}</th><th>Actual</th><th>Estimated</th><th>Unknown</th></tr></thead><tbody>
                  {rows(data).map(([k, v]) => <tr key={k}><td>{titleCase(k)}</td><td>{v.actual ? fmtInr(v.actual) : "—"}</td><td>{v.estimated ? fmtInr(v.estimated) : "—"}</td><td>{v.unknown ? `${v.unknown} records` : "—"}</td></tr>)}
                </tbody></table></div>
              </section>
            ))}
          </div>
          <section className="card section"><header><h2>Rate sources in this period</h2></header>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{c.rateSources.map((s) => <li key={s}>{s === "provider_reported" ? "Provider-reported (actual)" : s === "no_provider_cost_and_no_verified_rate" ? "None available — no provider cost and no verified rate (unknown)" : s}</li>)}</ul>
          </section>
        </>
      )}

      <section className="section" aria-labelledby="rates"><h2 id="rates">Verified unit rates</h2>
        <p>{hasRates ? <>Current rates (source: <b>{rates.source}</b>) are used to <Badge tone="info" icon="≈">estimate</Badge> calls that have no provider-reported cost.</> : "No rates configured: calls without a provider-reported cost show as unknown."}</p>
        <div className="card">
          {can(user.role, "admin") ? <CostRatesForm initial={rates} /> : <p className="muted">Only an admin can change cost rates.</p>}
        </div>
      </section>
    </>
  );
}
