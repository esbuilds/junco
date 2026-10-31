import { useEffect, useState } from 'react';
import {
  ACTION_LABEL, api, claimSupport, DECISION_LABEL, human, QUOTE_NOTE, UNQUOTED_NOTE, money, REASONS, STATUS, dueText, type CaseDetail, type Decision, holdWords, SUPPORT_NOTE } from '../api';
import { startReplay, useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';

interface ActResult { ok?: boolean; held?: boolean; reason?: string; status?: string; error?: { message: string } }
type Flash = { kind: 'ok' | 'held' | 'err'; text: string; detail?: string };

// Hidden from the desk for now (v3.6): one sandbox buyer makes the repeat note read as a flaw, and negotiation
// stays off screen until it has been tested live with a real buyer. Both still run on the server.
const SHOW_REPEAT_BUYER = false;
const SHOW_NEGOTIATION = false;

const WHEN: Record<string, string> = { now: 'Now', buyer_silent_48h: 'If the buyer is silent 48h', buyer_replies: 'When the buyer replies', paypal_review: 'If PayPal reviews' };
const STEP: Record<string, string> = { message: 'Message', offer: 'Offer', evidence: 'Submit evidence', supporting_info: 'Send PayPal the facts' };

export function CaseWidget() {
  const id = useSelectedCase();
  const { data: c, error, reload } = usePoll<CaseDetail>(id ? `/api/cases/${encodeURIComponent(id)}` : null, 5000, [id]);
  const [hl, setHl] = useState<string | null>(null); // evidence id lit by a hovered or focused citation
  const [draft, setDraft] = useState('');
  const [scan, setScan] = useState('');
  const [busy, setBusy] = useState<'recheck' | 'act' | 'budget' | 'plan' | 'negotiate' | null>(null);
  const [limit, setLimit] = useState('');
  const [flash, setFlash] = useState<Flash | null>(null);

  // Reset local UI when the case changes.
  useEffect(() => { setFlash(null); setScan(''); setHl(null); }, [id]);
  // Keep the editable message in step with the saved recommendation, without wiping a draft on every poll.
  const savedAt = c?.saved?.at ?? null;
  useEffect(() => { setDraft(c?.saved?.recommendation?.message_to_buyer ?? ''); }, [savedAt, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!id) {
    return (
      <Panel id="jd-case" title="Case">
        <div className="jd-empty">Pick a case in the queue.</div>
      </Panel>
    );
  }
  if (error && !c) return <Panel id="jd-case" title="Case"><div className="jd-result jd-err">{error}</div></Panel>;
  if (!c) return <Panel id="jd-case" title="Case"><div className="jd-empty">Loading case...</div></Panel>;

  const rec = c.saved?.recommendation ?? null;
  const problems = c.saved?.problems ?? [];
  const prev = c.saved?.previous ?? null;
  const canAct = !!rec && !problems.length && rec.decision !== 'wait';
  const editable = !!rec && !problems.length && (rec.decision === 'message' || rec.decision === 'offer');

  const recheck = async () => {
    setBusy('recheck'); setFlash(null);
    try {
      await api(`/api/cases/${encodeURIComponent(id)}/recommend`, { method: 'POST', json: { delivery_scan: scan || undefined } });
      setFlash({ kind: 'ok', text: 'Re-read the case.' });
      reload();
    } catch (e: any) {
      setFlash({ kind: 'err', text: e.message });
    } finally { setBusy(null); }
  };

  const act = async () => {
    setBusy('act'); setFlash(null);
    try {
      const r = await api<ActResult>(`/api/cases/${encodeURIComponent(id)}/act`, { method: 'POST', json: { message: editable ? draft : undefined } });
      setFlash(r.held
        ? { kind: 'held', text: 'Waiting for your approval.', detail: r.reason }
        : r.ok ? { kind: 'ok', text: `Done. PayPal accepted it (${r.status}).`, detail: "Allowed by the current case state and the owner's policy." }
        : { kind: 'err', text: 'Not done.', detail: r.error?.message ?? JSON.stringify(r) });
    } catch (e: any) {
      setFlash({ kind: 'err', text: 'Not done.', detail: e.message });
    } finally { setBusy(null); reload(); }
  };

  // "Handle it, up to $N": a standing approval for this dispute only. Held actions within it run right away.
  const handleIt = async (on: boolean) => {
    setBusy('budget'); setFlash(null);
    try {
      const r = await api<{ budget: any; ran?: { method: string }[] }>(`/api/cases/${encodeURIComponent(id)}/budget`,
        on ? { method: 'PUT', json: { limit: Number(limit || c?.amount) } } : { method: 'DELETE' });
      setFlash(on
        ? { kind: 'ok', text: `JUNCO handles this one up to ${money(r.budget.limit, c!.currency)}.`, detail: r.ran?.length ? `${r.ran.length} held action${r.ran.length === 1 ? '' : 's'} ran now.` : 'It acts on its own from the next PayPal update.' }
        : { kind: 'ok', text: 'Standing approval removed.' });
    } catch (e: any) {
      setFlash({ kind: 'err', text: 'Not done.', detail: e.message });
    } finally { setBusy(null); reload(); }
  };

  // Approve-a-plan: propose, approve once, cancel. Steps then run off PayPal updates.
  const planCall = async (method: 'POST' | 'DELETE', suffix = '') => {
    setBusy('plan'); setFlash(null);
    try { await api(`/api/cases/${encodeURIComponent(id)}/plan${suffix}`, { method }); }
    catch (e: any) { setFlash({ kind: 'err', text: 'Not done.', detail: e.message }); }
    finally { setBusy(null); reload(); }
  };

  const negotiate = async (method: 'POST' | 'DELETE') => {
    setBusy('negotiate'); setFlash(null);
    try { await api(`/api/cases/${encodeURIComponent(id)}/negotiate`, { method }); }
    catch (e: any) { setFlash({ kind: 'err', text: 'Not done.', detail: e.message }); }
    finally { setBusy(null); reload(); }
  };

  // Hover or focus on a citation lights up the evidence it cites.
  const litProps = (evId: string) => ({
    tabIndex: 0,
    onMouseEnter: () => setHl(evId), onMouseLeave: () => setHl(null),
    onFocus: () => setHl(evId), onBlur: () => setHl(null),
    'aria-label': `Cited evidence ${evId}`,
  });

  return (
    <Panel id="jd-case" title={`${REASONS[c.reason] ?? human(c.reason)}, ${money(c.amount, c.currency)}`}
      subtitle={`${c.id} · ${c.stage === 'CHARGEBACK' && c.channel === 'INTERNAL' ? 'PayPal claim' : human(c.stage)} · ${STATUS[c.status] ?? human(c.status)}${c.due ? ` · respond in ${dueText(c.due)}` : ''}`}>
      {SHOW_REPEAT_BUYER && (c.buyer_disputes ?? 0) >= 2 && (
        <div className="jd-repeat" role="note">Repeat buyer: this buyer has opened {c.buyer_disputes} disputes with you. Shown for you only; JUNCO's recommendation doesn't use it.</div>
      )}
      {(() => {
        // v3.15 move 1: an order a shopping agent placed. What it was asked next to what it bought, from the store's record.
        const rec = c.evidence.find((e) => e.source.startsWith('agent checkout record'));
        if (!rec) return null;
        const list = c.evidence.find((e) => e.source.startsWith('product listing at time of order'));
        const why = c.evidence.find((e) => e.source.startsWith("agent's stated reason"));
        const asked = rec.text.match(/Instruction the agent sent with the order: "(.*)" Budget given: (\S+)\.$/);
        const row = (label: string, e: typeof rec | undefined, text?: string) => e && (
          <div className={hl === e.id ? 'jd-hl' : undefined}><span className="jd-muted">{label}</span> {text ?? e.text} <button type="button" className="jd-cite" {...litProps(e.id)}>{e.id}</button></div>
        );
        return (
          <div className="jd-agent" role="note" aria-label="Bought by a shopping agent">
            <strong>Bought by an AI shopping agent for the buyer</strong>
            {row('Asked:', rec, asked ? `"${asked[1]}" (budget ${asked[2]})` : undefined)}
            {row('Bought:', list)}
            {row('Its reason:', why)}
            <div className="jd-muted jd-src">The store's record, not a PayPal mandate.</div>
          </div>
        );
      })()}
      <h3>PayPal allows now</h3>
      <div className="jd-chips">
        {c.allowed.length
          ? c.allowed.map((a) => <span key={a} className="jd-chip">{human(a)}</span>)
          : <span className="jd-muted">No merchant actions right now</span>}
      </div>

      <h3>Recommendation</h3>
      {rec ? (
        <div className="jd-rec">
          {prev && prev.decision !== rec.decision && (
            <div className="jd-diff" aria-label="What changed since the last check">
              <span className={`jd-badge jd-b-${prev.decision}`}>{DECISION_LABEL[prev.decision as Decision] ?? prev.decision}</span>
              <span aria-hidden="true">&rarr;</span>
              <span className={`jd-badge jd-b-${rec.decision}`}>{DECISION_LABEL[rec.decision]}</span>
              <span className="jd-muted">changed on re-check</span>
              {rec.change_reason && <p>{rec.change_reason}</p>}
            </div>
          )}
          <span className={`jd-badge jd-b-${rec.decision}`}>{DECISION_LABEL[rec.decision]}</span>
          {rec.offer_amount ? <strong> {money(rec.offer_amount, c.currency)}</strong> : null}
          <p>{rec.summary}</p>
          <ul className="jd-claims">
            {rec.claims.map((cl, i) => (
              <li key={i}>
                {cl.text}
                {cl.evidence_ids.map((e) => <button type="button" key={e} className="jd-cite" {...litProps(e)}>{e}</button>)}
                {(() => { const s = claimSupport(cl, c.evidence); return <>
                  {s.quote && <div className="jd-quote"><q>{s.quote.text}</q> <span className="jd-muted">Quote found in {s.quote.where}.</span></div>}
                  {s.unquoted && <div className="jd-muted" title="The evidence item exists; no quote was checked.">{UNQUOTED_NOTE}</div>}
                  {cl.support && <div className={`jd-muted jd-support-${cl.support.replace(' ', '-')}`} title={cl.support_reason}>{SUPPORT_NOTE[cl.support]}</div>}
                  {s.facts.map((f) => <div key={f.id} className="jd-fact"><span className="jd-muted">From {f.from}:</span> {f.text}</div>)}
                </>; })()}
              </li>
            ))}
          </ul>
          {rec.claims.some((cl) => claimSupport(cl, c.evidence).quote) && <p className="jd-muted jd-note">{QUOTE_NOTE}</p>}
          {rec.would_change_mind && (rec.decision === 'wait' || rec.decision === 'accept') && (
            <div className="jd-flip"><strong>What would change my mind</strong><p>{rec.would_change_mind}</p></div>
          )}
          {problems.length > 0 && (
            <div className="jd-problems"><strong>Blocked by checks</strong><ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
          )}
          {editable && (
            <>
              <h3>Message to buyer</h3>
              <textarea className="jd-textarea" maxLength={2000} aria-label="Message to buyer" value={draft} onChange={(e) => setDraft(e.target.value)} />
            </>
          )}
          {c.status !== 'RESOLVED' && (
            <details className="jd-scan">
              <summary className="jd-muted">Add a delivery scan</summary>
              <input type="text" aria-label="Carrier delivery scan" value={scan} onChange={(e) => setScan(e.target.value)}
                placeholder="e.g. Delivered, front door, San Jose CA 95131, Oct 4 2:14pm" />
            </details>
          )}
        </div>
      ) : (
        <>
          <p className="jd-muted">Not reviewed yet.</p>
          <input type="text" aria-label="Carrier delivery scan (optional)" value={scan} onChange={(e) => setScan(e.target.value)}
            placeholder="Carrier delivery scan (optional)" />
        </>
      )}
      <div className="jd-row">
        {canAct && <button type="button" className="jd-btn jd-primary" onClick={act} disabled={!!busy}>{busy === 'act' ? 'Working...' : ACTION_LABEL[rec!.decision as Decision]}</button>}
        <button type="button" className="jd-btn" onClick={recheck} disabled={!!busy}>{busy === 'recheck' ? 'Reading the case...' : rec ? 'Re-check' : 'Get recommendation'}</button>
        <a className="jd-linkish jd-casefile" href={`/api/cases/${encodeURIComponent(c.id)}/file.html`} target="_blank" rel="noreferrer">Case file</a>
        {c.incident && <a className="jd-linkish jd-casefile" href={`/incident/${encodeURIComponent(c.incident)}`} target="_blank" rel="noreferrer">Incident</a>}
        {c.activity.length >= 2 && <button type="button" className="jd-btn" onClick={() => startReplay(c.id, c.activity)} title="Watch what JUNCO did on this case, step by step">Replay what JUNCO did</button>}
      </div>
      {c.status !== 'RESOLVED' && (c.budget ? (
        <div className="jd-handle">
          <span><strong>JUNCO is handling this one</strong> on its own, up to {money(c.budget.limit, c.budget.currency)}.</span>
          <button type="button" className="jd-btn" onClick={() => handleIt(false)} disabled={!!busy}>Take it back</button>
        </div>
      ) : (
        <div className="jd-handle">
          <span className="jd-money-input">Handle it, up to $<input type="number" min={1} max={c.amount} step={1} placeholder={String(c.amount)}
            value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Most JUNCO may move on this dispute without asking" /></span>
          <button type="button" className="jd-btn" onClick={() => handleIt(true)} disabled={!!busy}>{busy === 'budget' ? 'Working...' : 'Let JUNCO handle it'}</button>
        </div>
      ))}
      {flash && (
        <div className={`jd-result jd-${flash.kind === 'ok' ? 'ok' : flash.kind === 'held' ? 'held' : 'err'}`} role="status">
          <strong>{flash.text}</strong> {flash.detail}
        </div>
      )}

      {SHOW_NEGOTIATION && c.status !== 'RESOLVED' && (c.allowed.includes('make_offer') || c.negotiation) && (
        <>
          <h3>Negotiate</h3>
          {!c.negotiation || c.negotiation.status === 'stopped' || c.negotiation.status === 'settled' ? (
            <div className="jd-row" style={{ marginTop: 0 }}>
              {c.negotiation?.status === 'settled' && <span className="jd-muted">Last negotiation settled.</span>}
              <button type="button" className="jd-btn" onClick={() => negotiate('POST')} disabled={!!busy || !c.allowed.includes('make_offer')}>{busy === 'negotiate' ? 'Opening...' : 'Negotiate a partial refund'}</button>
            </div>
          ) : (
            <div className="jd-plan">
              <p>{c.negotiation.status === 'needs_you' ? `Waiting for you: ${c.negotiation.note}. The held offer is in Waiting for you.` : `Negotiating: opens at ${c.negotiation.bounds.open_pct}%, never above ${c.negotiation.bounds.ceiling_pct}%, up to ${c.negotiation.bounds.max_rounds} rounds.`}</p>
              <ol>{c.negotiation.rounds.map((r, i) => (
                <li key={i} className="jd-step jd-step-done"><span className="jd-step-when">Round {i + 1}</span><span><strong>Offered {money(r.offered, c.currency)}</strong> <span className="jd-muted">{r.message}</span></span><span className="jd-step-status">{new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></li>
              ))}</ol>
              <div className="jd-row"><button type="button" className="jd-btn" onClick={() => negotiate('DELETE')} disabled={!!busy}>Stop negotiating</button></div>
            </div>
          )}
        </>
      )}

      {c.status !== 'RESOLVED' && (
        <>
          <h3>Plan</h3>
          {!c.plan || c.plan.status === 'cancelled' || c.plan.status === 'finished' ? (
            <div className="jd-row" style={{ marginTop: 0 }}>
              {c.plan?.status === 'finished' && <span className="jd-muted">Last plan finished.</span>}
              <button type="button" className="jd-btn" onClick={() => planCall('POST')} disabled={!!busy}>{busy === 'plan' ? 'Planning...' : 'Plan the next few days'}</button>
            </div>
          ) : (
            <div className="jd-plan">
              <p>{c.plan.summary}</p>
              <ol>
                {c.plan.steps.map((st, i) => (
                  <li key={i} className={`jd-step jd-step-${st.status}`}>
                    <span className="jd-step-when">{WHEN[st.when] ?? st.when}</span>
                    <span><strong>{STEP[st.action] ?? st.action}{st.amount ? ` ${money(Number(st.amount), c.currency)}` : ''}</strong> <span className="jd-muted">{st.text}</span></span>
                    <span className="jd-step-status">{st.status === 'waiting' ? (c.plan!.status === 'proposed' ? '' : 'waiting') : st.status}</span>
                  </li>
                ))}
              </ol>
              <div className="jd-row">
                {c.plan.status === 'proposed' && <button type="button" className="jd-btn jd-primary" onClick={() => planCall('POST', '/approve')} disabled={!!busy}>Approve plan</button>}
                <button type="button" className="jd-btn" onClick={() => planCall('DELETE')} disabled={!!busy}>{c.plan.status === 'proposed' ? 'Discard' : 'Stop plan'}</button>
                {c.plan.status === 'active' && <span className="jd-muted">Running since {new Date(c.plan.approved_at!).toLocaleString()}</span>}
              </div>
            </div>
          )}
        </>
      )}

      <h3>Evidence</h3>
      <ol className="jd-evidence">
        {c.evidence.map((e) => (
          <li key={e.id} className={hl === e.id ? 'jd-hl' : undefined}>
            <span className="jd-ev-id">{e.id}</span>
            <div>{e.text}<div className="jd-muted jd-src">{e.source}</div></div>
          </li>
        ))}
      </ol>

      {c.holds.length > 0 && (
        <>
          <h3>Gate history</h3>
          {c.holds.map((h) => (
            <div key={h.id} className="jd-muted">
              {human(h.method)}{h.asked_by ? ` (asked by the ${h.asked_by})` : ''}: held because {h.reason}, then {holdWords(h)}
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
