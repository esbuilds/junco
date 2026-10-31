// v3.15 move 3: a PayPal action the assistant asked for, shown in the chat as the gate decided it (a Studio tool
// component under the call's row). A held action can be approved or rejected here, through the same hold path as
// Waiting for you: the desk re-reads the case first and only the owner may decide on shared cases.
import { useState } from 'react';
import { api, holdWords, human, type Hold } from '../api';

export type GateData = { gate: 'held' | 'refused' | 'allowed' | 'failed'; hold_id?: string; reason?: string; paypal?: string };

// Read the gate's answer out of a gated tool's text result.
export function gateData(text: string): GateData {
  try {
    const j = JSON.parse(text);
    if (j.held) return { gate: 'held', hold_id: j.hold_id, reason: j.reason };
    if (j.error?.type?.startsWith('denied')) return { gate: 'refused', reason: j.error.message };
    if (j.error) return { gate: 'failed', reason: j.error.message ?? j.error.type };
  } catch {}
  return { gate: 'allowed', paypal: text.slice(0, 200) };
}

export function GateCard({ name, args, status, result }: { name: string; args: any; status: string; result?: any }) {
  const [decided, setDecided] = useState<Hold | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (status !== 'done' || !result) return <div className="jd-gatecard jd-muted">Asking the owner's policy gate about {human(name)}...</div>;
  if (!result.success) return <div className="jd-gatecard jd-err">Not done: {result.issues?.map((i: any) => i.message).join('; ')}</div>;
  const g: GateData = result.data ?? gateData(result.response ?? '');
  const decide = async (verb: 'approve' | 'reject') => {
    setBusy(true); setErr(null);
    try { setDecided(await api<Hold>(`/api/holds/${encodeURIComponent(g.hold_id!)}/${verb}`, { method: 'POST' })); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const what = `${human(name)}${args?.dispute_id ? ` on ${args.dispute_id}` : ''}${args?.offer_amount?.value ? `, $${args.offer_amount.value}` : ''}`;
  return (
    <div className={`jd-gatecard jd-gate-${g.gate}`}>
      <div><strong>{g.gate === 'held' ? 'Held for the owner' : g.gate === 'refused' ? 'Refused by policy' : g.gate === 'failed' ? 'PayPal refused it' : 'Allowed by policy'}</strong> · {what}</div>
      {g.reason && <div className="jd-muted">{g.gate === 'held' ? 'Why: ' : ''}{g.reason}</div>}
      {g.gate === 'held' && !decided && <div className="jd-muted">Nothing was sent to PayPal.</div>}
      {g.gate === 'allowed' && <div className="jd-muted">Sent to PayPal.</div>}
      {g.gate === 'held' && g.hold_id && (decided
        ? <div>{holdWords(decided)}</div>
        : <div className="jd-row">
            <button type="button" className="jd-btn jd-primary" disabled={busy} onClick={() => decide('approve')}>Approve</button>
            <button type="button" className="jd-btn jd-danger" disabled={busy} onClick={() => decide('reject')}>Reject</button>
            <span className="jd-muted">Approving re-reads the case. If it moved on, it's refused.</span>
          </div>)}
      {err && <div className="jd-err">{err}</div>}
    </div>
  );
}
