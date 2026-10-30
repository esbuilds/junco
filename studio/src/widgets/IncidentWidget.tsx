// BLACK BOX in Studio: one AI purchase's incident, from the same Incident JSON as the desk's incident page.
// Read-only apart from the what-if, which re-runs the gate on a recorded request and never reaches PayPal.
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Incident, IncidentSummary, ThreeRecords, WhatIf } from '../../../src/incident-types';
import { aiLines, modeOf, notInRecords, reachedPayPal, whatIfPreset } from '../../../src/incident-questions';
import { api } from '../api';
import { useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';

// Titles repeat ("Agent bought WKD-01 for ..." three times), so a choice also names its date, buyer txn and dispute.
export const incidentLabel = (i: IncidentSummary) =>
  `${new Date(i.last_at).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ...${i.id.slice(-6)}${i.dispute_id ? ` · ${i.dispute_id}` : ''} · ${i.title}`;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// What the AI believed, what the gate recorded and what PayPal says, from the incident JSON (no model, no extra PayPal read).
function Records({ r }: { r: ThreeRecords }) {
  return (
    <section className="jd-records" aria-label="Three records">
      <p className={r.agree === false ? 'jd-records-line jd-records-differ' : 'jd-records-line'}>{r.line}</p>
      <div className="jd-records-cols">
        {r.columns.map((c) => (
          <div key={c.title} className="jd-records-col">
            <h3><span className={`jd-mode jd-mode-${c.mode}`}>{c.mode.toUpperCase()}</span>{c.title}</h3>
            <dl>{c.rows.map((x, i) => <Fragment key={i}><dt>{x.label}</dt><dd>{x.value}</dd></Fragment>)}</dl>
          </div>
        ))}
      </div>
    </section>
  );
}

// Ask for your money back: on the visitor's own shopping agent purchase only (the incident says whether this viewer may
// ask). The support agent can only propose; every refund waits for the owner, and expires after 24 hours undecided.
type Ask = NonNullable<NonNullable<Incident['refund']>['ask']>;
const askState = (a: Ask) => a.outcome === 'asking' ? 'The support agent is reading your purchase.'
  : a.outcome !== 'held' ? 'The support agent proposed no refund. Nothing was sent to PayPal.'
  : a.hold_status === 'pending' ? `The support agent proposed a refund and the gate held it for the owner (hold ${a.hold_id}). Waiting for the owner${a.expires ? `; if they don't decide by ${when(a.expires)}, it expires and nothing moves` : ''}.`
  : a.hold_status === 'expired' ? `The owner didn't decide within 24 hours, so nothing moved. Hold ${a.hold_id} expired.`
  : a.hold_status === 'rejected' ? `The owner rejected it (hold ${a.hold_id}). Nothing was sent to PayPal.`
  : a.hold_status === 'completed' ? `The owner approved it (hold ${a.hold_id}), and PayPal made the refund.`
  : `Hold ${a.hold_id}: ${a.hold_status ?? 'not found'}.`;
function RefundBox({ inc, onDone }: { inc: Incident; onDone: () => void }) {
  const [why, setWhy] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const r = inc.refund!;
  if (!r.ask && !r.can_ask) return null;
  const ask = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/refund-ask', { method: 'POST', json: { capture_id: inc.purchase?.capture_id, reason: why } }); onDone(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="jd-shop">
      <h3>Ask for your money back</h3>
      {r.ask ? <>
        <p>{askState(r.ask)}</p>
        {r.ask.ai && <p className="jd-muted">The support agent's reply, in the AI's own words:{aiLines(r.ask.ai).map((l, i) => <span key={i}><br />{l}</span>)}</p>}
      </> : <>
        <p className="jd-sub">A support agent (Claude) reads your purchase and can propose a refund. Every refund waits for the store owner, who has 24 hours to decide; after that it expires and nothing moves.</p>
        <div className="jd-row">
          <input type="text" aria-label="Why you want it back (optional)" placeholder="Why you want it back (optional)" maxLength={200} value={why} onChange={(e) => setWhy(e.target.value)} style={{ flex: '1 1 220px' }} />
          <button type="button" className="jd-btn jd-primary" disabled={busy} onClick={ask}>{busy ? 'The support agent is reading your purchase...' : 'Ask the support agent for a refund'}</button>
        </div>
      </>}
      {err && <div className="jd-result jd-err">{err}</div>}
    </div>
  );
}

// Your AI buys, you investigate: the visitor's own shopping agent. A real sandbox order on the test buyer's saved PayPal
// account (or nothing, if the agent declines), then the incident opens below. Only this visitor and the owner list it.
type ShopState = { enabled: boolean; left: { you: number; today: number }; max_budget: number };
function ShopForm({ onDone }: { onDone: (id: string) => void }) {
  const { data, reload } = usePoll<ShopState>('/api/shop', 60000);
  const [ask, setAsk] = useState('');
  const [budget, setBudget] = useState('70');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  if (!data) return null;
  if (!data.enabled) return <p className="jd-muted">Sending your own shopping agent is off on this desk.</p>;
  const send = async () => {
    setBusy(true); setOut(null);
    try { const r = await api<{ id: string; text: string }>('/api/shop', { method: 'POST', json: { instruction: ask, budget: Number(budget) } }); setOut({ ok: true, text: r.text }); onDone(r.id); }
    catch (e: any) { setOut({ ok: false, text: e.message }); }
    finally { setBusy(false); reload(); }
  };
  return (
    <div className="jd-shop">
      <h3>Send your own shopping agent</h3>
      <p className="jd-sub">Tell it what to buy and your budget. It picks one of the demo store's three bags or buys nothing. If it buys, the store charges the test buyer's saved PayPal account in PayPal's sandbox, then you investigate the order here. {data.left.you} of your runs left today.</p>
      <div className="jd-row">
        <input type="text" aria-label="What to buy" placeholder="A waterproof bag for kayaking" maxLength={200} value={ask} onChange={(e) => setAsk(e.target.value)} style={{ flex: '1 1 220px' }} />
        <span className="jd-money-input">Budget $<input type="number" aria-label="Budget in dollars" min={1} max={data.max_budget} step={1} value={budget} onChange={(e) => setBudget(e.target.value)} /></span>
        <button type="button" className="jd-btn jd-primary" disabled={busy || ask.trim().length < 3} onClick={send}>{busy ? 'Your agent is shopping...' : 'Send it shopping'}</button>
      </div>
      {out && <div className={out.ok ? 'jd-result' : 'jd-result jd-err'} role="status">{out.text}</div>}
    </div>
  );
}

export function IncidentWidget() {
  const listPoll = usePoll<IncidentSummary[]>('/api/incidents', 30000), list = listPoll.data ?? [];
  const selectedCase = useSelectedCase();
  // ?id= picks the incident (a shared link); else the Desk's open case when it came from an AI purchase; else the latest.
  const linked = new URLSearchParams(location.search).get('id');
  const [id, setId] = useState<string | null>(linked);
  useEffect(() => { if (linked) return; const m = list.find((i) => i.dispute_id === selectedCase); if (m) setId(m.id); else if (!id && list[0]) setId(list[0].id); }, [selectedCase, list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: inc, error, reload: reloadInc } = usePoll<Incident>(id ? `/api/incident/${encodeURIComponent(id)}` : null, 15000);
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

  const shopped = (newId: string) => { setId(newId); listPoll.reload(); };
  if (!list.length) return <Panel title="Incident"><ShopForm onDone={shopped} /><p className="jd-muted">No AI purchases on record yet.</p></Panel>;
  return (
    <Panel title="Incident" subtitle={inc?.title ?? 'Loading...'}>
      <ShopForm onDone={shopped} />
      <div className="jd-row">
        <select className="jd-ellipsis" aria-label="Incident" value={id ?? ''} onChange={(e) => setId(e.target.value)}>
          {list.map((i) => <option key={i.id} value={i.id}>{incidentLabel(i)}</option>)}
        </select>
        {id && <a className="jd-linkish" href={`/incident/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">Full page</a>}
        {id && <a className="jd-linkish" href={`/incident/${encodeURIComponent(id)}/receipt`} target="_blank" rel="noreferrer">Receipt</a>}
        {inc?.dispute_id && <a className="jd-linkish" href={`/who-else?seed=${encodeURIComponent(inc.id)}`} target="_blank" rel="noreferrer">Who else?</a>}
      </div>
      {error && <div className="jd-result jd-err">{error}</div>}
      {inc?.records && <Records r={inc.records} />}
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
          {inc.refund && <RefundBox key={inc.id} inc={inc} onDone={reloadInc} />}
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
