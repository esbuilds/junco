import { useState } from 'react';
import { api, human, money, type Hold } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

export function HoldsWidget() {
  const { data, error, reload } = usePoll<Hold[]>('/api/holds', 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const decide = async (h: Hold, verb: 'approve' | 'reject') => {
    setBusy(h.id); setErr(null);
    try { await api(`/api/holds/${encodeURIComponent(h.id)}/${verb}`, { method: 'POST' }); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(null); reload(); }
  };

  const holds = data ?? [];
  return (
    <Panel title="Waiting for you" subtitle={holds.length ? `${holds.length} held action${holds.length === 1 ? '' : 's'}` : 'Nothing held'} live>
      {error && <div className="jd-result jd-err">{error}</div>}
      {err && <div className="jd-result jd-err">{err}</div>}
      {holds.length === 0 && !error && <div className="jd-empty">No actions are waiting for approval.</div>}
      {holds.map((h) => (
        <div key={h.id} className="jd-hold">
          <div>
            <strong>{human(h.method)}</strong> on{' '}
            <button type="button" className="jd-linkish" onClick={() => selectCase(h.args?.dispute_id ?? null)}>{h.args?.dispute_id}</button>
            {h.args?.offer_amount ? ` for ${money(h.args.offer_amount.value, h.args.offer_amount.currency_code)}` : ''}
            <div className="jd-held-why">Held: {h.reason}</div>
          </div>
          <div className="jd-row">
            <button type="button" className="jd-btn jd-primary" disabled={busy === h.id} onClick={() => decide(h, 'approve')}>Approve</button>
            <button type="button" className="jd-btn jd-danger" disabled={busy === h.id} onClick={() => decide(h, 'reject')}>Reject</button>
          </div>
        </div>
      ))}
    </Panel>
  );
}
