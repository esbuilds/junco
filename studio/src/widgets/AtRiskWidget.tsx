import { daysLeft, money, REASONS, human, type CaseRow } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

// "At risk this week": open cases where money could be lost soon, worked out from /api/cases alone.
// ponytail: rules are fixed here; move them into policy.json if the editable policy panel lands.
function risks(r: CaseRow): string[] {
  const out: string[] = [];
  const d = daysLeft(r.due);
  if (d !== null && d <= 7) out.push(d <= 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`);
  if (r.pending_holds) out.push('Waiting for your approval');
  if (r.decision === 'accept') out.push('JUNCO expects to lose it');
  if (r.problems) out.push('Recommendation failed checks');
  return out;
}

export function AtRiskWidget() {
  const { data, error } = usePoll<CaseRow[]>('/api/cases', 10000);
  const rows = (data ?? [])
    .filter((r) => r.status !== 'RESOLVED')
    .map((r) => ({ r, why: risks(r) }))
    .filter((x) => x.why.length)
    .sort((a, b) => (daysLeft(a.r.due) ?? 99) - (daysLeft(b.r.due) ?? 99) || b.r.amount - a.r.amount);
  const total = rows.reduce((s, x) => s + x.r.amount, 0);
  const cur = rows[0]?.r.currency ?? 'USD';

  return (
    <Panel title="At risk this week"
      subtitle={!data ? 'Loading' : rows.length ? `${rows.length} dispute${rows.length === 1 ? '' : 's'}, ${money(total, cur)} at risk` : 'Nothing at risk right now'}>
      {error && <div className="jd-result jd-err">{error}</div>}
      <ul className="jd-risk">
        {rows.map(({ r, why }) => (
          <li key={r.id}>
            <button type="button" className="jd-risk-row" onClick={() => selectCase(r.id)}>
              <span className="jd-risk-main"><strong>{REASONS[r.reason] ?? human(r.reason)}</strong> <span className="jd-muted">{r.id}</span></span>
              <span className="jd-risk-amt">{money(r.amount, r.currency)}</span>
              <span className="jd-risk-why">{why.map((w) => <span key={w} className="jd-badge jd-b-held">{w}</span>)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
