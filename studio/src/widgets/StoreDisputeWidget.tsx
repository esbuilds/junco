import { useState } from 'react';
import { api, type Activity } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

// M1 "Dispute this store": file a real sandbox dispute against the demo store as the buyer, then watch JUNCO work it.
// Steps come from the agent's activity log for that case, including PayPal's own re-read after an action.
type RunView = { dispute_id: string; at: string; steps: Activity[] };
type Status = { live_left: number; can_run: string | null; mine: RunView | null; recent: RunView[] };

export function StoreDisputeWidget() {
  const { data, error, reload } = usePoll<Status>('/api/store-dispute', 4000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/store-dispute', { method: 'POST' }); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); reload(); }
  };

  const shown = data?.mine ?? data?.recent[0] ?? null;
  const recorded = !data?.mine && !!shown;
  return (
    <Panel title="Dispute this store" subtitle={data ? `${data.live_left} live run${data.live_left === 1 ? '' : 's'} left` : 'Loading'} live>
      <p className="jd-muted">
        File a real PayPal sandbox dispute against our demo store, as the buyer, and watch JUNCO work it. PayPal takes about five minutes to open a new case to the seller, so JUNCO's first step comes then.
        PayPal's sandbox turns disputes filed this way into chargebacks under review, so JUNCO can send PayPal supporting
        information or hold an accept for the owner. Offers and buyer messages aren't possible on this case.
      </p>
      <div className="jd-row">
        <button type="button" className="jd-btn jd-primary" disabled={busy || !data || !!data.can_run} onClick={go}>
          {busy ? 'Filing with PayPal...' : 'Dispute this store'}
        </button>
        {data?.can_run && <span className="jd-muted">{data.can_run}</span>}
      </div>
      {(error || err) && <div className="jd-result jd-err">{err ?? error}</div>}
      {shown && (
        <div className="jd-store-run">
          <strong>{recorded ? 'Recorded: an earlier visitor\'s run' : 'Your case'}</strong>{' '}
          <button type="button" className="jd-linkish" onClick={() => selectCase(shown.dispute_id)}>{shown.dispute_id}</button>
          <ol className="jd-activity">
            {shown.steps.length === 0 && <li className="jd-muted">Filed {shown.at.slice(11, 16)} UTC. Waiting for PayPal's webhook.</li>}
            {shown.steps.map((s, i) => (
              <li key={i}><span className="jd-muted">{s.at.slice(11, 19)}</span> <strong>{s.step}</strong> {s.detail}</li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}
