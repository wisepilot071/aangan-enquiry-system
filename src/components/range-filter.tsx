export function RangeFilter({ scope, from, to, action }: { scope: string; from?: string; to?: string; action: string }) {
  return (
    <form method="get" action={action} className="row" aria-label="Date range">
      <input type="hidden" name="scope" value={scope} />
      <label>From<input type="date" name="from" defaultValue={from ?? ""} /></label>
      <label>To<input type="date" name="to" defaultValue={to ?? ""} /></label>
      <button className="btn secondary" style={{ alignSelf: "end" }}>Apply</button>
      {(from || to) ? <a className="btn secondary" style={{ alignSelf: "end" }} href={`${action}?scope=${scope}`}>All time</a> : null}
    </form>
  );
}
