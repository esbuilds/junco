// BLACK BOX in Studio: one AI purchase's incident, from the same Incident JSON as the desk's incident page.
// Read-only apart from the what-if, which re-runs the gate on a recorded request and never reaches PayPal.
import { useEffect, useRef, useState } from 'react';
import type { Incident, IncidentSummary, WhatIf } from '../../../src/incident-types';
import { modeOf, notInRecords, reachedPayPal, whatIfPreset } from '../../../src/incident-questions';
import { api } from '../api';
import { useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';

// Titles repeat ("Agent bought WKD-01 for ..." three times), so a choice also names its date, buyer txn and dispute.
export const incidentLabel = (i: IncidentSummary) =>
  `${new Date(i.last_at).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ...${i.id.slice(-6)}${i.dispute_id ? ` · ${i.dispute_id}` : ''} · ${i.title}`;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function IncidentWidget() {
  const list = usePoll<IncidentSummary[]>('/api/incidents', 30000).data ?? [];
  const selectedCase = useSelectedCase();
  // ?id= picks the incident (a shared link); else the Desk's open case when it came from an AI purchase; else the latest.
  const linked = new URLSearchParams(location.search).get('id');
  const [id, setId] = useState<string | null>(linked);
  useEffect(() => { if (linked) return; const m = list.find((i) => i.dispute_id === selectedCase); if (m) setId(m.id); else if (!id && list[0]) setId(list[0].id); }, [selectedCase, list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: inc, error } = usePoll<Incident>(id ? `/api/incident/${encodeURIComponent(id)}` : null, 15000);
  const [limit, setLimit] = useState('30');
  const [w, setW] = useState<WhatIf | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const calls = inc ? inc.events.filter((e) => e.kind === 'gate' || e.kind === 'hold').reverse() : [];
  const [target, setTarget] = useState('');
  const [focusLive, setFocusLive] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const missingRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { setW(null); setErr(null); setTarget(''); setFocusLive(false); setAnswer(null); }, [id]);
  const whatIf = (eventId: string, max: number) => api<WhatIf>(`/api/incident/${encodeURIComponent(inc!.id)}/what-if`, { method: 'POST', json: { event_id: eventId, max_amount: max } });
  const rerun = async () => {
    setErr(null);
    try { setW(await whatIf(target || calls[0].id, Number(limit))); }
    catch (e: any) { setErr(e.message); }
  };
  // The three preset questions, answered from the incident JSON and the what-if endpoint; no model call.
  const askLive = () => { setFocusLive(true); setAnswer(reachedPayPal(inc!).text); };
  const askMissing = () => { setFocusLive(false); const q = notInRecords(inc!); setAnswer(q.text); missingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  const askWhatIf = async () => {
    setFocusLive(false); setErr(null);
    const p = whatIfPreset(inc!);
    if (p.none) { setW(null); return setAnswer(p.none); }
    setLimit(String(p.limit));
    // Newest recorded move first; one without an amount limit (an accept, a message) is refused and the next is tried.
    for (const t of p.targets) {
      try { const r = await whatIf(t, p.limit); setTarget(t); setW(r); return setAnswer(`Re-ran ${r.method.replace(/_/g, ' ')} at a $${p.limit} limit: ${r.before.verdict} then, ${r.after.verdict} now. Nothing was sent to PayPal.`); }
      catch { /* no amount limit on this one */ }
    }
    setAnswer('None of the recorded moves has an amount limit to change: accepts and messages have none. Nothing was sent to PayPal.');
  };

  if (!list.length) return <Panel title="Incident"><p className="jd-muted">No AI purchases on record yet.</p></Panel>;
  return (
    <Panel title="Incident" subtitle={inc?.title ?? 'Loading...'}>
      <div className="jd-row">
        <select className="jd-ellipsis" aria-label="Incident" value={id ?? ''} onChange={(e) => setId(e.target.value)}>
          {list.map((i) => <option key={i.id} value={i.id}>{incidentLabel(i)}</option>)}
        </select>
        {id && <a className="jd-linkish" href={`/incident/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">Full page</a>}
        {id && <a className="jd-linkish" href={`/incident/${encodeURIComponent(id)}/receipt`} target="_blank" rel="noreferrer">Receipt</a>}
      </div>
      {error && <div className="jd-result jd-err">{error}</div>}
      {inc && <div className="jd-incident-grid">
        <div className="jd-incident-main">
          {!inc.decline && <div className="jd-counts">
            {([['Proposed', inc.counts.proposed], ['Approved', inc.counts.approved], ['Executed', inc.counts.executed], ['Outcome unknown', inc.counts.outcome_unknown]] as const)
              .map(([k, v]) => <div key={k}><span>{k}</span><strong>{v}</strong></div>)}
          </div>}
          <dl className="jd-facts">
            <dt>Buyer allowed</dt><dd>{inc.authority ? `${inc.authority.instruction} (budget ${inc.authority.budget}, ${inc.authority.agent})` : 'not in the records'}</dd>
            {inc.decline ? <>
              <dt>Bought</dt><dd>Nothing. No order was placed and no money moved.</dd>
              <dt>Why it declined</dt><dd>{inc.decline.reason}</dd>
              <dt>Listings it saw</dt><dd>{inc.decline.listings.join(' | ') || 'not in the records'}</dd>
            </> : <><dt>Bought</dt><dd>{inc.purchase ? `${inc.purchase.listing}, ${inc.purchase.amount}` : 'not in the records'}</dd></>}
          </dl>
          <ol className={focusLive ? 'jd-rail jd-focus-live' : 'jd-rail'}>
            {inc.events.map((e) => { const mode = modeOf(e); return (
              <li key={e.id} className={`jd-rail-${mode}`}>
                <div className="jd-rail-meta"><span className={`jd-mode jd-mode-${mode}`}>{mode.toUpperCase()}</span> {when(e.at)} · {e.actor}</div>
                <div>{e.summary}</div>
              </li>); })}
            {w && (
              <li className="jd-rail-what-if">
                <div className="jd-rail-meta"><span className="jd-mode jd-mode-what-if">WHAT-IF</span> {w.change}</div>
                <div>{w.method.replace(/_/g, ' ')}: was <strong>{w.before.verdict}</strong> ({w.before.reason}), would be <strong>{w.after.verdict}</strong> ({w.after.reason}).</div>
                <div className="jd-muted">PayPal calls: {w.paypal_calls}. Nothing was sent.</div>
              </li>
            )}
          </ol>
          {inc.missing.length > 0 && <p ref={missingRef} className="jd-muted">Not in the records: {inc.missing.join(' ')}</p>}
        </div>
        <aside className="jd-incident-side">
          <h3>Ask the records</h3>
          <div className="jd-stack">
            <button type="button" className="jd-btn" onClick={askLive}>Which actions reached PayPal?</button>
            <button type="button" className="jd-btn" onClick={askMissing}>What's not in the records?</button>
            {!inc.decline && <button type="button" className="jd-btn" onClick={askWhatIf}>{whatIfPreset(inc).label}</button>}
          </div>
          {answer && <p className="jd-answer" role="status">{answer}</p>}
          {calls.length > 0 && <>
            <h3>Re-run the gate</h3>
            <div className="jd-stack">
              <label className="jd-field">Recorded request
                <select aria-label="Recorded request" value={target || calls[0].id} onChange={(e) => setTarget(e.target.value)}>
                  {calls.map((e) => <option key={e.id} value={e.id}>{when(e.at)}: {e.summary.slice(0, 80)}</option>)}
                </select>
              </label>
              <label className="jd-field">Amount limit (USD) <input type="number" min={0} max={10000} value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
              <button type="button" className="jd-btn jd-primary" onClick={rerun}>Re-run the gate</button>
              <p className="jd-sub">A what-if on the recorded request. Nothing reaches PayPal.</p>
            </div>
          </>}
          {err && <div className="jd-result jd-err">{err}</div>}
        </aside>
      </div>}
    </Panel>
  );
}
