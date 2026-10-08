import { useEffect, useState } from 'react';
import {
  ACTION_LABEL, api, DECISION_LABEL, human, money, REASONS, STATUS, dueText, type CaseDetail, type Decision,
} from '../api';
import { useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';

interface ActResult { ok?: boolean; held?: boolean; reason?: string; status?: string; error?: { message: string } }
type Flash = { kind: 'ok' | 'held' | 'err'; text: string; detail?: string };

export function CaseWidget() {
  const id = useSelectedCase();
  const { data: c, error, reload } = usePoll<CaseDetail>(id ? `/api/cases/${encodeURIComponent(id)}` : null, 5000, [id]);
  const [hl, setHl] = useState<string | null>(null); // evidence id lit by a hovered or focused citation
  const [draft, setDraft] = useState('');
  const [scan, setScan] = useState('');
  const [busy, setBusy] = useState<'recheck' | 'act' | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);

  // Reset local UI when the case changes.
  useEffect(() => { setFlash(null); setScan(''); setHl(null); }, [id]);
  // Keep the editable message in step with the saved recommendation, without wiping a draft on every poll.
  const savedAt = c?.saved?.at ?? null;
  useEffect(() => { setDraft(c?.saved?.recommendation?.message_to_buyer ?? ''); }, [savedAt, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!id) {
    return (
      <Panel title="Case" subtitle="Pick a case in the queue">
        <div className="jd-empty">Pick a case to see its evidence and what JUNCO recommends.</div>
      </Panel>
    );
  }
  if (error && !c) return <Panel title="Case"><div className="jd-result jd-err">{error}</div></Panel>;
  if (!c) return <Panel title="Case"><div className="jd-empty">Loading case...</div></Panel>;

  const rec = c.saved?.recommendation ?? null;
  const problems = c.saved?.problems ?? [];
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
        : r.ok ? { kind: 'ok', text: `Done. PayPal accepted it (${r.status}).` }
        : { kind: 'err', text: 'Not done.', detail: r.error?.message ?? JSON.stringify(r) });
    } catch (e: any) {
      setFlash({ kind: 'err', text: 'Not done.', detail: e.message });
    } finally { setBusy(null); reload(); }
  };

  // Hover or focus on a citation lights up the evidence it cites.
  const litProps = (evId: string) => ({
    tabIndex: 0,
    onMouseEnter: () => setHl(evId), onMouseLeave: () => setHl(null),
    onFocus: () => setHl(evId), onBlur: () => setHl(null),
    'aria-label': `Cited evidence ${evId}`,
  });

  return (
    <Panel title={`${REASONS[c.reason] ?? human(c.reason)}, ${money(c.amount, c.currency)}`}
      subtitle={`${c.id} · ${c.stage === 'CHARGEBACK' && c.channel === 'INTERNAL' ? 'PayPal claim' : human(c.stage)} · ${STATUS[c.status] ?? human(c.status)}${c.due ? ` · respond in ${dueText(c.due)}` : ''}`}>
      <h3>PayPal allows now</h3>
      <div className="jd-chips">
        {c.allowed.length
          ? c.allowed.map((a) => <span key={a} className="jd-chip">{human(a)}</span>)
          : <span className="jd-muted">No merchant actions right now</span>}
      </div>

      <h3>Recommendation</h3>
      {rec ? (
        <div className="jd-rec">
          <span className={`jd-badge jd-b-${rec.decision}`}>{DECISION_LABEL[rec.decision]}</span>
          {rec.offer_amount ? <strong> {money(rec.offer_amount, c.currency)}</strong> : null}
          <p>{rec.summary}</p>
          <ul className="jd-claims">
            {rec.claims.map((cl, i) => (
              <li key={i}>
                {cl.text}
                {cl.evidence_ids.map((e) => <button type="button" key={e} className="jd-cite" {...litProps(e)}>{e}</button>)}
              </li>
            ))}
          </ul>
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
              <summary className="jd-muted">Add a carrier delivery scan and re-check</summary>
              <input type="text" aria-label="Carrier delivery scan" value={scan} onChange={(e) => setScan(e.target.value)}
                placeholder="e.g. Delivered, front door, San Jose CA 95131, Oct 4 2:14pm" />
            </details>
          )}
        </div>
      ) : (
        <>
          <p className="jd-muted">Not reviewed yet. JUNCO reads the dispute, the PayPal order and tracking, and recommends one action with every claim cited.</p>
          <input type="text" aria-label="Carrier delivery scan (optional)" value={scan} onChange={(e) => setScan(e.target.value)}
            placeholder="Carrier delivery scan (optional)" />
        </>
      )}
      <div className="jd-row">
        {canAct && <button type="button" className="jd-btn jd-primary" onClick={act} disabled={!!busy}>{busy === 'act' ? 'Working...' : ACTION_LABEL[rec!.decision as Decision]}</button>}
        <button type="button" className="jd-btn" onClick={recheck} disabled={!!busy}>{busy === 'recheck' ? 'Reading the case...' : rec ? 'Re-check' : 'Get recommendation'}</button>
      </div>
      {flash && (
        <div className={`jd-result jd-${flash.kind === 'ok' ? 'ok' : flash.kind === 'held' ? 'held' : 'err'}`} role="status">
          <strong>{flash.text}</strong> {flash.detail}
        </div>
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
              {human(h.method)}: held because {h.reason}, then {h.status === 'pending' ? 'waiting for you' : `${h.status} by owner`}
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
