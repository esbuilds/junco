import { useState } from 'react';
import { api, human, money, HOLD_STATUS, type Hold } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

export function HoldsWidget() {
  const { data, error, reload } = usePoll<Hold[]>('/api/holds', 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const decide = async (h: Hold, verb: 'approve' | 'reject' | 'settle') => {
    setBusy(h.id); setErr(null);
    try {
      const r = await api<Hold>(`/api/holds/${encodeURIComponent(h.id)}/${verb}`, { method: 'POST' });
      if (['failed', 'unknown', 'executing'].includes(r.status)) setErr(`${human(r.method)}: ${HOLD_STATUS[r.status]}.`);
    }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(null); reload(); }
  };

  const holds = data ?? [];
  // With nothing held the card collapses to one line, with no card chrome, so the space goes to the rest of the desk.
  if (holds.length === 0 && !error && !err) {
    return (
      <div className="jd-holds-empty" aria-live="polite">
        <h2>Waiting for you</h2>
        <span className="jd-muted">Nothing waiting for you</span>
      </div>
    );
  }
  return (
    <Panel title="Waiting for you" subtitle={holdsLine(holds)} live>
      {error && <div className="jd-result jd-err">{error}</div>}
      {err && <div className="jd-result jd-err">{err}</div>}
      {holds.map((h) => (
        <div key={h.id} className="jd-hold">
          <div>
            <strong>{human(h.method)}</strong> on{' '}
            {h.args?.dispute_id ? <button type="button" className="jd-linkish" onClick={() => selectCase(h.args.dispute_id)}>{h.args.dispute_id}</button> : h.args?.capture_id ? `payment ${h.args.capture_id}` : 'the store'}
            {h.args?.offer_amount ? ` for ${money(h.args.offer_amount.value, h.args.offer_amount.currency_code)}` : ''}
            <div className="jd-held-why">Held: {h.reason}</div>
            {h.asked_by && <div className="jd-held-why">Asked by the {h.asked_by}</div>}
            {h.status === 'pending' && h.recheck && <div className="jd-held-why jd-recheck">Re-check: PayPal says this {h.args?.capture_id ? 'payment' : 'case'} changed since it was held ({h.recheck.event}). {h.recheck.refund ? `PayPal reported refund ${h.recheck.refund.id} on it, so approving will refuse this.` : 'Approving re-reads it first.'}</div>}
            {h.status !== 'pending' && <div className="jd-held-why">Status: {HOLD_STATUS[h.status] ?? h.status}. It won't be sent again.</div>}
          </div>
          <div className="jd-row">
            {h.status === 'pending' ? <>
              <button type="button" className="jd-btn jd-primary" disabled={busy === h.id} onClick={() => decide(h, 'approve')}>Approve</button>
              <button type="button" className="jd-btn jd-danger" disabled={busy === h.id} onClick={() => decide(h, 'reject')}>Reject</button>
            </> : <button type="button" className="jd-btn" disabled={busy === h.id} onClick={() => decide(h, 'settle')}>Re-check PayPal</button>}
          </div>
        </div>
      ))}
    </Panel>
  );
}

// Same count as the Gate record's "waiting": approved holds still settling with PayPal are named apart.
function holdsLine(holds: { status: string }[]) {
  const waiting = holds.filter((h) => h.status === 'pending').length, settling = holds.length - waiting;
  if (!holds.length) return 'Nothing held';
  return [waiting && `${waiting} waiting for you`, settling && `${settling} approved, outcome being checked with PayPal`].filter(Boolean).join(' · ');
}
