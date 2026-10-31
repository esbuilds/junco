import { useEffect, useRef, useState } from 'react';
import { api, type Activity } from '../api';
import { selectCase, usePoll } from '../store';
import { Clip } from './Clip';
import { Panel } from './Panel';

// M1 "Dispute this store" (STRATEGY v3.12): a visitor takes a real sandbox dispute against the demo store, filed ahead
// by the sandbox buyer, and watches JUNCO work it. Two kinds: an order never shipped (JUNCO holds an accept for the
// visitor to approve or reject) and an order with a delivery record entered by this demo store (JUNCO sends it as
// supporting info). Steps come from the agent's activity log, including PayPal's own re-read after an action.
type Kind = 'unshipped' | 'delivered' | 'agent';
type RunView = { dispute_id: string; kind: Kind | null; at: string; lease_until: string; yours: boolean; steps: Activity[] };
type Status = { kinds: Record<Kind, { live_left: number; can_run: string | null }>; mine: RunView | null; recent: RunView[] };
const KINDS: Kind[] = ['unshipped', 'delivered', 'agent'];
const LABEL: Record<Kind, string> = { unshipped: 'An order that was never shipped', delivered: 'An order that was delivered', agent: 'An order an AI agent bought' };

export function StoreDisputeWidget() {
  const { data, error, reload } = usePoll<Status>('/api/store-dispute', 4000);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const go = async (kind: Kind) => {
    setBusy(kind); setErr(null);
    try { const r = await api<{ dispute_id: string }>('/api/store-dispute', { method: 'POST', json: { kind } }); selectCase(r.dispute_id); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(null); reload(); }
  };

  const shown = data?.mine ?? data?.recent[0] ?? null;
  const recorded = !data?.mine && !!shown;
  // D1: while your lease lasts, the desk opens on your case (once per page load).
  const live = !!data?.mine?.yours && Date.parse(data.mine.lease_until) > Date.now();
  const opened = useRef(false);
  useEffect(() => { if (live && !opened.current) { opened.current = true; selectCase(data!.mine!.dispute_id); } }, [live, data]);

  const left = data ? KINDS.reduce((n, k) => n + (data.kinds[k]?.live_left ?? 0), 0) : 0;
  return (
    <Panel title="Dispute this store" subtitle={data ? `${left} live case${left === 1 ? '' : 's'} left` : 'Loading'} live>
      <div id="store-dispute" />
      <p className="jd-muted">A real PayPal sandbox dispute against our demo store, filed by the sandbox buyer. Yours for 30 minutes.</p>
      <details className="jd-store-more">
        <summary className="jd-muted">What each case does</summary>
        <ul className="jd-muted">
          <li>Never shipped: JUNCO should hold an accept for you to approve or reject.</li>
          <li>Delivered: JUNCO should send PayPal the delivery record the store entered itself.</li>
          <li>AI agent: JUNCO weighs what the agent was asked against what it bought, from the store's record.</li>
          <li>PayPal's sandbox opens some as chargebacks under review, where only supporting info or an accept is possible.</li>
        </ul>
      </details>
      <div className="jd-row">
        {KINDS.map((k) => (
          <button key={k} type="button" className="jd-btn jd-primary" disabled={!!busy || !data || !!data.kinds[k].can_run} onClick={() => go(k)}>
            {busy === k ? 'Opening your case...' : LABEL[k]}
          </button>
        ))}
      </div>
      {data && KINDS.filter((k) => data.kinds[k].can_run).map((k) => (
        <div key={k} className="jd-muted">{LABEL[k]}: {data.kinds[k].can_run}</div>
      ))}
      {(error || err) && <div className="jd-result jd-err">{err ?? error}</div>}
      {shown && (
        <div className="jd-store-run">
          <strong>{recorded ? 'Recorded: an earlier visitor\'s run' : 'Your case'}</strong>{' '}
          <button type="button" className="jd-linkish" onClick={() => selectCase(shown.dispute_id)}>{shown.dispute_id}</button>
          {shown.kind && <span className="jd-muted"> · {shown.kind === 'unshipped' ? 'never shipped' : shown.kind === 'agent' ? 'bought by a shopping agent' : 'delivery record entered by this demo store'}</span>}
          {!recorded && <span className="jd-muted"> · {live
            ? `yours to act on until ${new Date(shown.lease_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : shown.yours ? 'your 30 minutes are over; this run is read-only now' : 'read-only'}</span>}
          <ol className="jd-activity">
            {shown.steps.length === 0 && <li className="jd-muted">Opened {shown.at.slice(11, 16)} UTC. JUNCO is starting.</li>}
            {shown.steps.map((s, i) => (
              <li key={i}><span className="jd-muted">{s.at.slice(11, 19)}</span> <strong>{s.step}</strong> <span><Clip text={s.detail} /></span></li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}
