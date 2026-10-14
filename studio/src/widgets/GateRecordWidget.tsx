import { human } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

// The Gate record (v3.14 item 1): every money move proposed to the gate, from every source (desk agent, dashboard
// assistant, MCP clients, PayPal's hosted server, Break the mandate, the red team), with the gate's verdict and what
// became of it. All of it read from the hold store, the gate's log and the run records on the server; nothing from the model.
type Row = { at: string; source: string; dispute_id: string | null; method: string; amount: string | null; verdict: string; outcome: string; hold_id?: string; run_id?: string; reason: string };
type Record = { counts: { proposed: number; held: number; approved: number; rejected: number; stale: number; pending: number; allowed: number; denied: number; gate_only: number; past_limit: number }; rows: Row[] };

const VERDICT: { [k: string]: string } = { hold: 'Held for the owner', allow: 'Allowed by policy', deny: 'Denied', 'gate-only': 'Gate-only test' };

export function GateRecordWidget() {
  const { data, error } = usePoll<Record>('/api/gate-record', 15000);
  const c = data?.counts;
  return (
    <Panel title="Gate record" subtitle={c ? `${c.proposed} money moves proposed · ${c.held} held for the owner · ${c.past_limit} past the limit` : 'Loading'}>
      <div id="gate-record" />
      {error && <div className="jd-result jd-err">{error}</div>}
      {c && <p className="jd-muted">Of the holds: {c.approved} approved by the owner, {c.rejected} rejected, {c.stale} stale, {c.pending} waiting. Also {c.allowed} allowed inside the owner's limits, {c.denied} denied, and {c.gate_only} gate-only tests that made no hold and sent nothing.</p>}
      <div className="jd-table-wrap">
        <table className="jd-table">
          <thead><tr><th>When (UTC)</th><th>Asked by</th><th>Move</th><th>Case</th><th>Gate</th><th>What happened</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).map((r, i) => (
              <tr key={r.hold_id ?? r.run_id ?? `${r.at}-${i}`} title={r.reason}>
                <td>{r.at.slice(0, 16).replace('T', ' ')}</td>
                <td>{r.source}</td>
                <td>{human(r.method)}{r.amount ? ` ${r.amount}` : ''}</td>
                <td>{r.dispute_id ? <button type="button" className="jd-linkish" onClick={() => selectCase(r.dispute_id)}>{r.dispute_id}</button> : ''}</td>
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
