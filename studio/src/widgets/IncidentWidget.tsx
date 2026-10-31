// BLACK BOX in Studio: one AI purchase's incident, from the same Incident JSON as the desk's incident page.
// Read-only apart from the what-if, which re-runs the gate on a recorded request and never reaches PayPal.
import { useEffect, useRef, useState } from 'react';
import type { Incident, IncidentSummary, ThreeRecords, WhatIf } from '../../../src/incident-types';
import { aiLines, ID_TOKEN, modeOf, notInRecords, reachedPayPal, verdict, whatIfPreset } from '../../../src/incident-questions';
import { api } from '../api';
import { useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';
import '../../../public/photo-client.js'; // one upload control and one card, shared with the incident page and the phone page

// Titles repeat ("Agent bought WKD-01 for ..." three times), so a choice also names its date, buyer txn and dispute.
export const incidentLabel = (i: IncidentSummary) =>
  `${new Date(i.last_at).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ...${i.id.slice(-6)}${i.dispute_id ? ` · ${i.dispute_id}` : ''} · ${i.title}`;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Ids set in mono, so a sentence reads past them. The full value stays on the page.
const withIds = (t: string) => t.split(new RegExp(`(${ID_TOKEN.source})`)).map((x, i) => (i % 2 ? <code key={i}>{x}</code> : x));

// The first thing a reader takes away: the one-line verdict, then whether the three records agree.
function Verdict({ inc }: { inc: Incident }) {
  const r = inc.records, [, head, rest] = r?.line.match(/^([^.]+\.)\s*(.*)$/s) ?? [];
  const state = !r ? 'open' : r.agree === false ? 'differ' : r.agree ? 'agree' : 'open';
  return (
    <header className="jd-verdict-head">
      <h3 className="jd-verdict">{verdict(inc)}</h3>
      <p className={`jd-inc-status jd-inc-status-${state}`}>{r ? <><strong>{head ?? r.line}</strong>{rest && <> {withIds(rest)}</>}</> : 'No order was placed and no money moved.'}</p>
    </header>
  );
}

// What the AI believed, what the gate recorded and what PayPal says, from the incident JSON (no model, no extra PayPal read).
function Records({ r }: { r: ThreeRecords }) {
  return (
    <section className="jd-records" aria-label="Three records">
      {r.columns.map((c) => (
        <div key={c.title} className="jd-records-col">
          <h4>{c.title}</h4>
          <span className={`jd-mode jd-mode-${c.mode}`}>{c.mode.toUpperCase()}</span>
          <dl>{c.rows.map((x, i) => <div key={i} className={/^\d+$/.test(x.value) ? 'jd-rec-row jd-rec-num' : 'jd-rec-row'}><dt>{withIds(x.label)}</dt><dd>{withIds(x.value)}</dd></div>)}</dl>
        </div>
      ))}
    </section>
  );
}

// A closed section: native disclosure, so the rest of the page stays quiet until it's asked for.
function Section({ title, note, open, children }: { title: string; note?: string; open?: React.Ref<HTMLDetailsElement>; children: React.ReactNode }) {
  return <details className="jd-section" ref={open}><summary><span>{title}</span>{note && <span className="jd-section-note">{note}</span>}</summary><div className="jd-section-body">{children}</div></details>;
}

// Ask for your money back: on the visitor's own shopping agent purchase only (the incident says whether this viewer may
// ask). The support agent can only propose; every refund waits for the owner, and expires after 24 hours undecided. The
// visitor who asked also gets "Approve it yourself" for that one hold, recorded as the demo approver (demo-approver.ts).
type Ask = NonNullable<NonNullable<Incident['refund']>['ask']>;
const decider = (a: Ask) => { const by = a.decided_by ?? 'the owner'; return by[0].toUpperCase() + by.slice(1); };
const askState = (a: Ask) => a.outcome === 'asking' ? 'The support agent is reading your purchase.'
  : a.outcome !== 'held' ? 'The support agent proposed no refund. Nothing was sent to PayPal.'
  : a.hold_status === 'pending' ? `The support agent proposed a refund and the gate held it for the owner (hold ${a.hold_id}). Waiting for the owner${a.expires ? `; if they don't decide by ${when(a.expires)}, it expires and nothing moves` : ''}.`
  : a.hold_status === 'expired' ? `The owner didn't decide within 24 hours, so nothing moved. Hold ${a.hold_id} expired.`
  : a.hold_status === 'rejected' ? `${decider(a)} rejected it (hold ${a.hold_id}). Nothing was sent to PayPal.`
  : a.hold_status === 'completed' ? `${decider(a)} approved it (hold ${a.hold_id}), and PayPal made the refund.`
  : `Hold ${a.hold_id}: ${a.hold_status ?? 'not found'}.`;
// An optional photo, before the ask: the upload, then the card. Nothing shows on a purchase that has none and can't add one.
const juncoPhoto = () => (window as any).juncoPhoto;
function PhotoSlot({ inc, onDone }: { inc: Incident; onDone: () => void }) {
  const o = inc.refund?.photo_offer, can = !!o && !o.why, [again, setAgain] = useState(false), el = useRef<HTMLDivElement>(null);
  const adding = can && !inc.refund?.ask && (!inc.photo || again);
  useEffect(() => { if (adding && el.current) juncoPhoto().control(el.current, { url: '/api/photo', extra: { capture_id: inc.purchase?.capture_id }, offer: o, onDone: () => { setAgain(false); onDone(); } }); }, [adding, o?.url]); // eslint-disable-line react-hooks/exhaustive-deps
  if (adding) return <div ref={el} />;
  return <>
    {inc.photo && <div dangerouslySetInnerHTML={{ __html: juncoPhoto().card(inc.photo) }} />}
    {inc.photo && can && !inc.refund?.ask && <p><button type="button" className="jd-linkish" onClick={() => setAgain(true)}>Use a different photo</button></p>}
    {o?.why && !inc.refund?.ask && <p className="jd-muted">{o.why}</p>}
  </>;
}
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
    <div className="jd-refund">
      <h4>Ask for your money back</h4>
      {r.ask ? <>
        <p>{askState(r.ask)}</p>
        {r.ask.ai && <p className="jd-muted">The support agent's reply, in the AI's own words:{aiLines(r.ask.ai).map((l, i) => <span key={i}><br />{l}</span>)}</p>}
        <PhotoSlot inc={inc} onDone={onDone} />
        {r.demo && (r.demo.url ? <div className="jd-demo">
          <img src={r.demo.qr!} alt="QR code for your approve link" />
          <div>
            <h4>Approve it yourself</h4>
            <p>You are the demo approver for this one sandbox refund. You can't approve anything else.</p>
            <p><a className="jd-btn jd-primary" href={r.demo.url} target="_blank" rel="noreferrer">Open your approve link here</a></p>
            <p className="jd-muted">Scan it with your phone, or open it here. It works once and ends with the hold. It proves you hold the link, not who you are, and the record will say the demo approver, never the owner.</p>
          </div>
        </div> : <p className="jd-muted">{r.demo.why}</p>)}
      </> : <>
        <p className="jd-sub">A support agent (Claude) reads your purchase and can propose a refund. It waits for the store owner, who has 24 hours to decide; after that it expires and nothing moves. If it's held, you'll get a link to approve this one sandbox refund yourself, as the demo approver.</p>
        <PhotoSlot inc={inc} onDone={onDone} />
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
  const [shopping, setShopping] = useState(false);
  const missingRef = useRef<HTMLDetailsElement>(null), timelineRef = useRef<HTMLDetailsElement>(null), whatIfRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => { setW(null); setErr(null); setTarget(''); setFocusLive(false); setAnswer(null); }, [id]);
  const whatIf = (eventId: string, max: number) => api<WhatIf>(`/api/incident/${encodeURIComponent(inc!.id)}/what-if`, { method: 'POST', json: { event_id: eventId, max_amount: max } });
  const rerun = async () => {
    setErr(null);
    try { setW(await whatIf(target || calls[0].id, Number(limit))); }
    catch (e: any) { setErr(e.message); }
  };
  // The three preset questions, answered from the incident JSON and the what-if endpoint; no model call.
  const reveal = (d: HTMLDetailsElement | null) => { if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } };
  const askLive = () => { setFocusLive(true); setAnswer(reachedPayPal(inc!).text); reveal(timelineRef.current); };
  const askMissing = () => { setFocusLive(false); setAnswer(notInRecords(inc!).text); reveal(missingRef.current); };
  const askWhatIf = async () => {
    setFocusLive(false); setErr(null);
    const p = whatIfPreset(inc!);
    if (p.none) { setW(null); return setAnswer(p.none); }
    setLimit(String(p.limit));
    // Newest recorded move first; one without an amount limit (an accept, a message) is refused and the next is tried.
    for (const t of p.targets) {
      try { const r = await whatIf(t, p.limit); setTarget(t); setW(r); reveal(whatIfRef.current); return setAnswer(`Re-ran ${r.method.replace(/_/g, ' ')} at a $${p.limit} limit: ${r.before.verdict} then, ${r.after.verdict} now. Nothing was sent to PayPal.`); }
      catch { /* no amount limit on this one */ }
    }
    setAnswer('None of the recorded moves has an amount limit to change: accepts and messages have none. Nothing was sent to PayPal.');
  };

  const shopped = (newId: string) => { setId(newId); listPoll.reload(); };
  const send = <button type="button" className="jd-btn jd-primary" aria-expanded={shopping} onClick={() => setShopping(!shopping)}>Send your own shopping agent</button>;
  if (!list.length) return <Panel id="jd-incident" hug title="Incident"><ShopForm onDone={shopped} /><p className="jd-muted">No AI purchases on record yet.</p></Panel>;
  const count = inc?.missing.length ?? 0;
  return (
    <Panel id="jd-incident" hug title="Incident" action={send}>
      {shopping && <ShopForm onDone={shopped} />}
      <div className="jd-inc-tools">
        <select className="jd-ellipsis" aria-label="Incident" value={id ?? ''} onChange={(e) => setId(e.target.value)}>
          {list.map((i) => <option key={i.id} value={i.id}>{incidentLabel(i)}</option>)}
        </select>
        {id && <a className="jd-linkish" href={`/incident/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">Full page</a>}
        {id && <a className="jd-linkish" href={`/incident/${encodeURIComponent(id)}/receipt`} target="_blank" rel="noreferrer">Receipt</a>}
        {inc?.dispute_id && <a className="jd-linkish" href={`/who-else?seed=${encodeURIComponent(inc.id)}`} target="_blank" rel="noreferrer">Who else?</a>}
      </div>
      {error && <div className="jd-result jd-err">{error}</div>}
      {inc && <div key={inc.id}>
        <Verdict inc={inc} />
        {inc.refund && <RefundBox inc={inc} onDone={reloadInc} />}
        {inc.records ? <Records r={inc.records} /> : inc.decline && <dl className="jd-decline">
          <div className="jd-rec-row"><dt>Asked</dt><dd>{inc.authority?.instruction ?? 'not in the records'}</dd></div>
          <div className="jd-rec-row"><dt>Budget</dt><dd>{inc.authority?.budget ?? 'not in the records'}</dd></div>
          <div className="jd-rec-row"><dt>Why it declined</dt><dd>{inc.decline.reason}</dd></div>
          <div className="jd-rec-row"><dt>Listings it saw</dt><dd>{inc.decline.listings.length ? <ul>{inc.decline.listings.map((l) => <li key={l}>{l}</li>)}</ul> : 'not in the records'}</dd></div>
        </dl>}
        <p className="jd-sub jd-inc-legend">LIVE: PayPal's sandbox did it. RECORDED: the desk's own record. WHAT-IF: the gate re-run on a recorded request; it never reaches PayPal.</p>
        <div className="jd-sections">
          <Section title="What happened" note={`${inc.events.length} event${inc.events.length === 1 ? '' : 's'}`} open={timelineRef}>
            <ol className={focusLive ? 'jd-rail jd-focus-live' : 'jd-rail'}>
              {inc.events.map((e) => { const mode = modeOf(e); return (
                <li key={e.id} className={`jd-rail-${mode}`}>
                  <div className="jd-rail-meta"><span className={`jd-mode jd-mode-${mode}`}>{mode.toUpperCase()}</span> {when(e.at)} · {e.actor}</div>
                  <div>{withIds(e.summary)}</div>
                </li>); })}
            </ol>
          </Section>
          <Section title="What's not in the records" note={count ? `${count} listed` : 'Nothing listed'} open={missingRef}>
            <p>{notInRecords(inc).text}</p>
            {count > 0 && <ul>{inc.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
          </Section>
          <Section title="Ask the records">
            <div className="jd-row">
              <button type="button" className="jd-btn" onClick={askLive}>Which actions reached PayPal?</button>
              <button type="button" className="jd-btn" onClick={askMissing}>What's not in the records?</button>
              {!inc.decline && <button type="button" className="jd-btn" onClick={askWhatIf}>{whatIfPreset(inc).label}</button>}
            </div>
            {answer && <p className="jd-answer" role="status">{answer}</p>}
          </Section>
          {calls.length > 0 && <Section title="What if" note="Nothing reaches PayPal" open={whatIfRef}>
            <div className="jd-inc-whatif">
              <label className="jd-field">Recorded request
                <select aria-label="Recorded request" value={target || calls[0].id} onChange={(e) => setTarget(e.target.value)}>
                  {calls.map((e) => <option key={e.id} value={e.id}>{when(e.at)}: {e.summary.slice(0, 80)}</option>)}
                </select>
              </label>
              <label className="jd-field">Amount limit (USD) <input type="number" min={0} max={10000} value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
              <button type="button" className="jd-btn jd-primary" onClick={rerun}>Re-run the gate</button>
            </div>
            {w && <div className="jd-inc-result">
              <div className="jd-rail-meta"><span className="jd-mode jd-mode-what-if">WHAT-IF</span> {w.change}</div>
              <div>{w.method.replace(/_/g, ' ')}: was <strong>{w.before.verdict}</strong> ({w.before.reason}), would be <strong>{w.after.verdict}</strong> ({w.after.reason}).</div>
              <div className="jd-muted">PayPal calls: {w.paypal_calls}. Nothing was sent.{w.note ? ` ${w.note}` : ''}</div>
            </div>}
            {err && <div className="jd-result jd-err">{err}</div>}
          </Section>}
          {inc.purchase && <Section title="Purchase details">
            <dl className="jd-facts">
              <dt>Incident</dt><dd><code>{inc.id}</code></dd>
              <dt>Agent</dt><dd>{inc.authority?.agent ?? 'not in the records'}</dd>
              <dt>Listing it saw</dt><dd>{inc.purchase.listing}</dd>
              {inc.purchase.order_id && <><dt>Order</dt><dd><code>{inc.purchase.order_id}</code></dd></>}
              {inc.purchase.capture_id && <><dt>Capture</dt><dd><code>{inc.purchase.capture_id}</code></dd></>}
              {inc.dispute_id && <><dt>Dispute</dt><dd><code>{inc.dispute_id}</code></dd></>}
            </dl>
          </Section>}
        </div>
      </div>}
    </Panel>
  );
}
