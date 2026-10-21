import { useState } from 'react';
import { api, DECISION_LABEL, claimSupport, QUOTE_NOTE, type Claim, type Decision, type Evidence } from '../api';
import { usePoll } from '../store';
import { Panel } from './Panel';

// "Try the brain": run JUNCO's real recommender and checks on a made-up case. Nothing reaches PayPal.
type Result = {
  scenario: { id: string; why: string; expected: Decision[]; never: Decision[] };
  recommendation: { decision: Decision; summary: string; claims: Claim[]; offer_amount: string | null; would_change_mind?: string | null } | null;
  problems: string[]; evidence: Evidence[];
};

export function TryWidget() {
  const { data: list } = usePoll<{ id: string; tag: string; why: string }[]>('/api/try/scenarios', 3_600_000);
  const [mode, setMode] = useState<'pick' | 'own'>('pick');
  const [pick, setPick] = useState('inject-buyer-system');
  const [own, setOwn] = useState({ reason: 'inr', amount: '48', tracking: 'shipped', scan: '', message: 'It never arrived. Refund me now or I report you.' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);

  const run = async () => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await api<Result>('/api/try', { method: 'POST', json: mode === 'pick' ? { scenario_id: pick } : { ...own, amount: Number(own.amount) } })); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const rec = res?.recommendation;
  const verdict = res && rec && res.scenario.id !== 'custom'
    ? res.scenario.never.includes(rec.decision) ? 'wrong' : res.scenario.expected.includes(rec.decision) ? 'pass' : 'outside'
    : null;
  const tags = [...new Set((list ?? []).map((s) => s.tag))];

  return (
    <Panel title="Try the brain" subtitle="Scenario mode: a made-up case through JUNCO's real recommender and checks. Nothing is sent to PayPal.">
      <div className="jd-row" style={{ marginTop: 0 }}>
        <button type="button" className="jd-tab" aria-current={mode === 'pick' ? 'page' : undefined} onClick={() => setMode('pick')}>Pick a test case</button>
        <button type="button" className="jd-tab" aria-current={mode === 'own' ? 'page' : undefined} onClick={() => setMode('own')}>Write your own</button>
      </div>
      {mode === 'pick' ? (
        <label className="jd-try-field">One of the {list?.length ?? 43} eval scenarios
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            {tags.map((t) => <optgroup key={t} label={t}>{(list ?? []).filter((s) => s.tag === t).map((s) => <option key={s.id} value={s.id}>{s.why}</option>)}</optgroup>)}
          </select>
        </label>
      ) : (
        <div className="jd-try-grid">
          <label className="jd-try-field">Reason<select value={own.reason} onChange={(e) => setOwn({ ...own, reason: e.target.value })}><option value="inr">Item not received</option><option value="snad">Not as described</option></select></label>
          <label className="jd-try-field">Amount ($)<input type="number" min={1} max={2000} value={own.amount} onChange={(e) => setOwn({ ...own, amount: e.target.value })} /></label>
          <label className="jd-try-field">Tracking on PayPal<select value={own.tracking} onChange={(e) => setOwn({ ...own, tracking: e.target.value })}><option value="shipped">Shipped</option><option value="none">None</option><option value="cancelled">Cancelled label</option></select></label>
          <label className="jd-try-field">Delivery scan (optional)<input type="text" maxLength={200} value={own.scan} placeholder="Delivered, front door, San Jose CA 95131, Oct 4 2:14pm" onChange={(e) => setOwn({ ...own, scan: e.target.value })} /></label>
          <label className="jd-try-field jd-try-wide">What the buyer says<textarea maxLength={600} value={own.message} onChange={(e) => setOwn({ ...own, message: e.target.value })} /></label>
        </div>
      )}
      <div className="jd-row"><button type="button" className="jd-btn jd-primary" onClick={run} disabled={busy}>{busy ? 'Thinking...' : 'Run JUNCO'}</button></div>
      {err && <div className="jd-result jd-err">{err}</div>}
      {res && (
        <div className="jd-rec" style={{ marginTop: 12 }}>
          {rec ? (
            <>
              <span className={`jd-badge jd-b-${rec.decision}`}>{DECISION_LABEL[rec.decision]}</span>
              {rec.offer_amount && <strong> ${rec.offer_amount}</strong>}
              {verdict && <span className={`jd-badge ${verdict === 'pass' ? 'jd-b-contest' : verdict === 'wrong' ? 'jd-b-accept' : 'jd-b-held'}`} style={{ marginLeft: 8 }}>{verdict === 'pass' ? 'Matches the eval' : verdict === 'wrong' ? 'Eval says wrong' : 'Outside the eval\'s expected answers'}</span>}
              <p>{rec.summary}</p>
              <ul className="jd-claims">{rec.claims.map((c, i) => <li key={i}>{c.text} {c.evidence_ids.map((e) => <span key={e} className="jd-cite">{e}</span>)}{(() => { const s = claimSupport(c, res.evidence); return <>{s.quote && <div className="jd-quote"><q>{s.quote.text}</q> <span className="jd-muted">Quote found in {s.quote.where}.</span></div>}{s.facts.map((f) => <div key={f.id} className="jd-fact"><span className="jd-muted">From {f.from}:</span> {f.text}</div>)}</>; })()}</li>)}</ul>
              {rec.claims.some((c) => claimSupport(c, res.evidence).quote) && <p className="jd-muted jd-note">{QUOTE_NOTE}</p>}
              {rec.would_change_mind && <div className="jd-flip"><strong>What would change my mind</strong><p>{rec.would_change_mind}</p></div>}
            </>
          ) : <p>No recommendation came back.</p>}
          {res.problems.length > 0 && <div className="jd-problems"><strong>Blocked by checks</strong><ul>{res.problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
          <details style={{ marginTop: 10 }}><summary className="jd-muted">Evidence it was given ({res.evidence.length})</summary>
            <ol className="jd-evidence">{res.evidence.map((e) => <li key={e.id}><span className="jd-ev-id">{e.id}</span><span>{e.text}<span className="jd-muted"> {e.source}</span></span></li>)}</ol>
          </details>
        </div>
      )}
    </Panel>
  );
}
