import { useState } from 'react';
import { human } from '../api';
import { selectCase, usePoll } from '../store';
import { recentView } from '../ui';
import { Panel } from './Panel';

// The Gate record (v3.14 item 1): every money move proposed to the gate, from every source (desk agent, dashboard
// assistant, MCP clients, PayPal's hosted server, Break the mandate, the red team), with the gate's verdict and what
// became of it. All of it read from the hold store, the gate's log and the run records on the server; nothing from the model.
type Row = { at: string; source: string; dispute_id: string | null; method: string; amount: string | null; verdict: string; outcome: string; hold_id?: string; run_id?: string; reason: string };
type Record = { counts: { proposed: number; held: number; approved: number; demo_approved: number; leased_approved?: number; rejected: number; stale: number; pending: number; allowed: number; denied: number; gate_only: number; past_limit: number }; daily_total?: { approved_in_advance: string; max: number; calls: number } | null; rows: Row[] };

const VERDICT: { [k: string]: string } = { hold: 'Held', allow: 'Allowed', deny: 'Denied', 'gate-only': 'Gate-only test' };

const COUNT_TITLE: { [k: string]: string } = { 'Demo approver': 'Approved by the demo approver (a desk visitor)', 'Leased visitor': 'Approved by a visitor on their leased case' };

const SHOW = 6; // the newest real moves; View all and the gate-only toggle reach the rest
const gateOnlyWords = (s: string) => s.replace(/^gate-only run: the gate would (\w+) it; no hold made, nothing sent$/, 'would $1, nothing sent');

export function GateRecordWidget() {
  const { data, error } = usePoll<Record>('/api/gate-record', 15000);
  const c = data?.counts;
  const [all, setAll] = useState(false), [tests, setTests] = useState(false);
  const { kept, shown, tests: testRows } = recentView(data?.rows ?? [], (r) => r.verdict === 'gate-only', { tests, all, n: SHOW });
  return (
    <Panel title="Gate record" subtitle={c ? undefined : 'Loading'}
      action={kept.length > SHOW ? <button type="button" className="jd-linkish jd-muted" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `View all ${kept.length}`}</button> : undefined}>
      <div id="gate-record" />
      {error && <div className="jd-result jd-err">{error}</div>}
      {data?.daily_total && <div className="jd-sub" title="Offers count even though no money moves until a buyer accepts. Past the total, calls wait for you.">Approved in advance today (UTC): ${data.daily_total.approved_in_advance} of ${data.daily_total.max}, {data.daily_total.calls} {data.daily_total.calls === 1 ? 'call' : 'calls'}</div>}
      {c && (
        <div className="jd-counts" aria-label="Gate counts">
          {([['Proposed', c.proposed], ['Held', c.held], ['Approved', c.approved], ...(c.demo_approved ? [['Demo approver', c.demo_approved] as const] : []), ...(c.leased_approved ? [['Leased visitor', c.leased_approved] as const] : []),['Rejected', c.rejected], ['Stale', c.stale], ['Waiting', c.pending], ['Allowed', c.allowed], ['Denied', c.denied], ['Gate-only tests', c.gate_only], ['Past the limit', c.past_limit]] as const).map(([k, v]) => (
            <div key={k} title={COUNT_TITLE[k]}><span>{k}</span><strong>{v}</strong></div>
          ))}
        </div>
      )}
      <div className="jd-table-wrap">
        <table className="jd-table">
          <thead><tr><th>When (UTC)</th><th>Asked by</th><th>Move</th><th>Case</th><th>Gate</th><th>What happened</th></tr></thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.hold_id ?? r.run_id ?? `${r.at}-${i}`} title={r.reason}>
                <td className="jd-id jd-nowrap">{r.at.slice(0, 16).replace('T', ' ')}</td>
                <td title={r.source}>{r.source.replace(/ [0-9a-f-]{36}$/, '')}</td>
                <td className="jd-nowrap">{human(r.method).replace(/^./, (x) => x.toUpperCase())}{r.amount && <div className="jd-sub jd-num">{r.amount}</div>}</td>
                <td>{r.dispute_id ? <button type="button" className="jd-linkish jd-id jd-nowrap" onClick={() => selectCase(r.dispute_id)}>{r.dispute_id}</button> : <span className="jd-faint">-</span>}</td>
                <td>{VERDICT[r.verdict] ?? r.verdict}</td>
                <td title={r.outcome}>{gateOnlyWords(r.outcome)}{r.run_id && <> · <a href={`/run/${r.run_id}`} target="_blank" rel="noreferrer">run</a></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {testRows > 0 && <button type="button" className="jd-linkish jd-muted jd-more" onClick={() => setTests(!tests)}>{tests ? 'Hide gate-only tests' : `Show ${testRows} gate-only tests`}</button>}
    </Panel>
  );
}
