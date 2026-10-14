import { useEffect, useRef, useState } from 'react';
import { api, type Activity } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

// M1 "Dispute this store" (STRATEGY v3.12): a visitor takes a real sandbox dispute against the demo store, filed ahead
// by the sandbox buyer, and watches JUNCO work it. Two kinds: an order never shipped (JUNCO holds an accept for the
// visitor to approve or reject) and an order with a delivery record entered by this demo store (JUNCO sends it as
// supporting info). Steps come from the agent's activity log, including PayPal's own re-read after an action.
type Kind = 'unshipped' | 'delivered';
type RunView = { dispute_id: string; kind: Kind | null; at: string; lease_until: string; yours: boolean; steps: Activity[] };
type Status = { kinds: Record<Kind, { live_left: number; can_run: string | null }>; mine: RunView | null; recent: RunView[] };
const KINDS: Kind[] = ['unshipped', 'delivered'];
const LABEL: Record<Kind, string> = { unshipped: 'An order that was never shipped', delivered: 'An order that was delivered' };

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

  const left = data ? data.kinds.unshipped.live_left + data.kinds.delivered.live_left : 0;
  return (
    <Panel title="Dispute this store" subtitle={data ? `${left} live case${left === 1 ? '' : 's'} left` : 'Loading'} live>
      <div id="store-dispute" />
      <p className="jd-muted">
        Take a real PayPal sandbox dispute against our demo store, filed by the sandbox buyer as "item not received", and
        watch JUNCO work it. The case is yours for 30 minutes; nobody else can approve or send anything on it. Never
        shipped: JUNCO should hold an accept for you to approve or reject. Delivered: the store has a delivery record it
        entered itself, and JUNCO should send it to PayPal on its own. PayPal's sandbox opens some of these as ordinary
        cases and some as chargebacks under review, where only supporting info or an accept is possible.
      </p>
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
          {shown.kind && <span className="jd-muted"> · {shown.kind === 'unshipped' ? 'never shipped' : 'delivery record entered by this demo store'}</span>}
          {!recorded && <span className="jd-muted"> · {live
            ? `yours to act on until ${new Date(shown.lease_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : shown.yours ? 'your 30 minutes are over; this run is read-only now' : 'read-only'}</span>}
          <ol className="jd-activity">
            {shown.steps.length === 0 && <li className="jd-muted">Opened {shown.at.slice(11, 16)} UTC. JUNCO is starting.</li>}
            {shown.steps.map((s, i) => (
              <li key={i}><span className="jd-muted">{s.at.slice(11, 19)}</span> <strong>{s.step}</strong> {s.detail}</li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}
