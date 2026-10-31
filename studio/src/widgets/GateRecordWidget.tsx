import { human } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

// The Gate record (v3.14 item 1): every money move proposed to the gate, from every source (desk agent, dashboard
// assistant, MCP clients, PayPal's hosted server, Break the mandate, the red team), with the gate's verdict and what
// became of it. All of it read from the hold store, the gate's log and the run records on the server; nothing from the model.
type Row = { at: string; source: string; dispute_id: string | null; method: string; amount: string | null; verdict: string; outcome: string; hold_id?: string; run_id?: string; reason: string };
type Record = { counts: { proposed: number; held: number; approved: number; demo_approved: number; rejected: number; stale: number; pending: number; allowed: number; denied: number; gate_only: number; past_limit: number }; daily_total?: { approved_in_advance: string; max: number; calls: number } | null; rows: Row[] };

const VERDICT: { [k: string]: string } = { hold: 'Held for the owner', allow: 'Allowed by policy', deny: 'Denied', 'gate-only': 'Gate-only test' };

export function GateRecordWidget() {
  const { data, error } = usePoll<Record>('/api/gate-record', 15000);
  const c = data?.counts;
  return (
    <Panel title="Gate record" subtitle={c ? `${c.proposed} money moves proposed · ${c.held} held for the owner · ${c.past_limit} past the limit` : 'Loading'}>
      <div id="gate-record" />
      {error && <div className="jd-result jd-err">{error}</div>}
      {data?.daily_total && <div className="jd-sub">Approved in advance today (UTC): ${data.daily_total.approved_in_advance} of ${data.daily_total.max}, {data.daily_total.calls} {data.daily_total.calls === 1 ? 'call' : 'calls'}. Offers count even though no money moves until a buyer accepts. Past the total, calls wait for you.</div>}
      {c && (
        <div className="jd-counts" aria-label="Gate counts">
          {([['Proposed', c.proposed], ['Held', c.held], ['Approved', c.approved], ...(c.demo_approved ? [['Approved by the demo approver', c.demo_approved] as const] : []), ['Rejected', c.rejected], ['Stale', c.stale], ['Waiting', c.pending], ['Allowed by policy', c.allowed], ['Denied', c.denied], ['Gate-only tests', c.gate_only], ['Past the limit', c.past_limit]] as const).map(([k, v]) => (
            <div key={k}><span>{k}</span><strong>{v}</strong></div>
          ))}
        </div>
      )}
      <div className="jd-table-wrap">
        <table className="jd-table">
          <thead><tr><th>When (UTC)</th><th>Asked by</th><th>Move</th><th>Case</th><th>Gate</th><th>What happened</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).map((r, i) => (
              <tr key={r.hold_id ?? r.run_id ?? `${r.at}-${i}`} title={r.reason}>
                <td className="jd-id jd-nowrap">{r.at.slice(0, 16).replace('T', ' ')}</td>
                <td>{r.source}</td>
                <td>{human(r.method).replace(/^./, (x) => x.toUpperCase())}{r.amount && <div className="jd-sub jd-num">{r.amount}</div>}</td>
                <td>{r.dispute_id ? <button type="button" className="jd-linkish jd-id jd-nowrap" onClick={() => selectCase(r.dispute_id)}>{r.dispute_id}</button> : <span className="jd-faint">No case</span>}</td>
                <td>{VERDICT[r.verdict] ?? r.verdict}</td>
                <td>{r.outcome}{r.run_id && <> · <a href={`/run/${r.run_id}`} target="_blank" rel="noreferrer">run</a></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
