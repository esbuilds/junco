import { useEffect, useState } from 'react';
import { api } from '../api';
import { usePoll } from '../store';
import { Panel } from './Panel';

// Owner policy: what JUNCO may do on its own and what waits for approval. The gate reads it on every call.
type PolicyView = { offer_limit: number; ship_within_days: number; auto: Record<string, boolean> };
const ACTIONS: [string, string, string][] = [
  ['send_dispute_message', 'Message the buyer', 'No money moves'],
  ['provide_dispute_evidence', 'Submit evidence to PayPal', 'Contests the case'],
  ['provide_dispute_supporting_info', 'Add supporting info while PayPal reviews', 'Contests the case'],
  ['accept_dispute_claim', 'Accept a claim', 'Refunds the buyer in full'],
  ['create_refund', 'Issue a refund', 'Moves money'],
];

export function PolicyWidget() {
  const { data, error, reload } = usePoll<PolicyView>('/api/policy', 30000);
  const [draft, setDraft] = useState<PolicyView | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (data && !draft) setDraft(data); }, [data, draft]);

  const send = async (method: 'PUT' | 'DELETE') => {
    setMsg(null);
    try {
      const next = await api<PolicyView>('/api/policy', method === 'PUT' ? { method, json: draft } : { method });
      setDraft(next); reload();
      setMsg({ ok: true, text: method === 'PUT' ? 'Saved. The gate uses this from the next action.' : 'Reset to the default policy.' });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };

  if (!draft) return <Panel title="Policy">{error ? <div className="jd-result jd-err">{error}</div> : <div className="jd-empty">Loading</div>}</Panel>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data);

  return (
    <Panel title="Policy" subtitle="What JUNCO does on its own, and what waits for you">
      <label className="jd-policy-row">
        <span><strong>Auto-offer limit</strong><span className="jd-muted">Partial refund offers up to this amount go out without asking. Larger offers wait for you.</span></span>
        <span className="jd-money-input">$<input type="number" min={0} max={500} step={1} value={draft.offer_limit}
          onChange={(e) => setDraft({ ...draft, offer_limit: Number(e.target.value) })} aria-label="Auto-offer limit in dollars" /></span>
      </label>
      <label className="jd-policy-row">
        <span><strong>Ship-by window</strong><span className="jd-muted">Shipment watch flags a paid order with no tracking on PayPal after this many days.</span></span>
        <span className="jd-money-input"><input type="number" min={1} max={30} step={1} value={draft.ship_within_days}
          onChange={(e) => setDraft({ ...draft, ship_within_days: Number(e.target.value) })} aria-label="Ship-by window in days" /> days</span>
      </label>
      {ACTIONS.map(([key, label, note]) => (
        <label key={key} className="jd-policy-row">
          <span><strong>{label}</strong><span className="jd-muted">{note}</span></span>
          <select value={draft.auto[key] ? 'allow' : 'hold'} onChange={(e) => setDraft({ ...draft, auto: { ...draft.auto, [key]: e.target.value === 'allow' } })} aria-label={label}>
            <option value="allow">Do it</option>
            <option value="hold">Ask me first</option>
          </select>
        </label>
      ))}
      <div className="jd-row">
        <button type="button" className="jd-btn jd-primary" disabled={!dirty} onClick={() => send('PUT')}>Save policy</button>
        <button type="button" className="jd-btn" onClick={() => send('DELETE')}>Reset to default</button>
      </div>
      {msg && <div className={`jd-result ${msg.ok ? 'jd-ok' : 'jd-err'}`}>{msg.text}</div>}
    </Panel>
  );
}
