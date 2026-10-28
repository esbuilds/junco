// BLACK BOX in Studio: one AI purchase's incident, from the same Incident JSON as the desk's incident page.
// Read-only apart from the what-if, which re-runs the gate on a recorded request and never reaches PayPal.
import { useEffect, useState } from 'react';
import type { Incident, IncidentSummary, WhatIf } from '../../../src/incident-types';
import { api } from '../api';
import { useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';

// Same rule as modeOf in src/incident-view.ts: PayPal's events, and gate calls it allowed straight through, are LIVE.
const LIVE = ['purchase', 'payment', 'dispute', 'paypal', 'webhook'];
const modeOf = (e: Incident['events'][number]) => LIVE.includes(e.kind) || (e.kind === 'gate' && /the gate allowed it/.test(e.summary)) ? 'live' : 'recorded';
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function IncidentWidget() {
  const list = usePoll<IncidentSummary[]>('/api/incidents', 30000).data ?? [];
  const selectedCase = useSelectedCase();
  const [id, setId] = useState<string | null>(null);
  // Follows the Desk's open case when that case came from an AI purchase; otherwise the latest incident.
  useEffect(() => { const m = list.find((i) => i.dispute_id === selectedCase); if (m) setId(m.id); else if (!id && list[0]) setId(list[0].id); }, [selectedCase, list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: inc, error } = usePoll<Incident>(id ? `/api/incident/${encodeURIComponent(id)}` : null, 15000);
  const [limit, setLimit] = useState('30');
  const [w, setW] = useState<WhatIf | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const calls = inc ? inc.events.filter((e) => e.kind === 'gate' || e.kind === 'hold').reverse() : [];
  const [target, setTarget] = useState('');
  useEffect(() => { setW(null); setErr(null); setTarget(''); }, [id]);
  const rerun = async () => {
    setErr(null);
    try { setW(await api<WhatIf>(`/api/incident/${encodeURIComponent(inc!.id)}/what-if`, { method: 'POST', json: { event_id: target || calls[0].id, max_amount: Number(limit) } })); }
    catch (e: any) { setErr(e.message); }
  };

  if (!list.length) return <Panel title="Incident"><p className="jd-muted">No AI purchases on record yet.</p></Panel>;
  return (
    <Panel title="Incident" subtitle={inc?.title ?? 'Loading...'}>
      <div className="jd-row">
        <select aria-label="Incident" value={id ?? ''} onChange={(e) => setId(e.target.value)}>
          {list.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
        </select>
        {inc && <a className="jd-linkish" href={`/incident/${encodeURIComponent(inc.id)}`} target="_blank" rel="noreferrer">Full page</a>}
        {inc && <a className="jd-linkish" href={`/incident/${encodeURIComponent(inc.id)}/receipt`} target="_blank" rel="noreferrer">Receipt</a>}
      </div>
      {error && <div className="jd-result jd-err">{error}</div>}
      {inc && <>
        <div className="jd-incident-counts">
          {([['Proposed', inc.counts.proposed], ['Approved', inc.counts.approved], ['Executed', inc.counts.executed], ['Outcome unknown', inc.counts.outcome_unknown]] as const)
            .map(([k, v]) => <div key={k}><span className="jd-muted">{k}</span><strong>{v}</strong></div>)}
        </div>
        <p><strong>Buyer allowed:</strong> {inc.authority ? `${inc.authority.instruction} (budget ${inc.authority.budget}, ${inc.authority.agent})` : 'not in the records'}</p>
        <p><strong>Bought:</strong> {inc.purchase ? `${inc.purchase.sku}, ${inc.purchase.listing}, ${inc.purchase.amount}` : 'not in the records'}</p>
        <ol className="jd-rail">
          {inc.events.map((e) => { const mode = modeOf(e); return (
            <li key={e.id} className={`jd-rail-${mode}`}>
              <div className="jd-muted"><span className={`jd-mode jd-mode-${mode}`}>{mode.toUpperCase()}</span> {when(e.at)} · {e.actor}</div>
              <div>{e.summary}</div>
            </li>); })}
          {w && (
            <li className="jd-rail-what-if">
              <div className="jd-muted"><span className="jd-mode jd-mode-what-if">WHAT-IF</span> {w.change}</div>
              <div>{w.method.replace(/_/g, ' ')}: was <strong>{w.before.verdict}</strong> ({w.before.reason}), would be <strong>{w.after.verdict}</strong> ({w.after.reason}).</div>
              <div className="jd-muted">PayPal calls: {w.paypal_calls}. Nothing was sent.</div>
            </li>
          )}
        </ol>
        {inc.missing.length > 0 && <p className="jd-muted">Not in the records: {inc.missing.join(' ')}</p>}
        {calls.length > 0 && <div className="jd-row">
          <select aria-label="Recorded request" value={target || calls[0].id} onChange={(e) => setTarget(e.target.value)} style={{ maxWidth: '100%' }}>
            {calls.map((e) => <option key={e.id} value={e.id}>{when(e.at)}: {e.summary.slice(0, 80)}</option>)}
          </select>
          <label className="jd-muted">Amount limit (USD) <input type="number" min={0} max={10000} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 90 }} /></label>
          <button type="button" className="jd-btn" onClick={rerun}>Re-run the gate</button>
        </div>}
        {err && <div className="jd-result jd-err">{err}</div>}
      </>}
    </Panel>
  );
}
