import { Fragment, useState } from 'react';
import { api, human, money, HOLD_STATUS, type Hold } from '../api';
import { selectCase, usePoll } from '../store';
import { approveLabel, canDecide, holdsLine, policyWords, splitHolds } from '../ui';
import { Panel } from './Panel';

const SHOW = 3; // pending rows before "View all"; the widget never scrolls inside

export function HoldsWidget() {
  const { data, error, reload } = usePoll<Hold[]>('/api/holds', 5000);
  // Who is looking: the owner decides any hold, a visitor only the one on the case they lease (the server's rule).
  const owner = usePoll<{ owner?: boolean }>('/api/status', 60000).data?.owner;
  const own = usePoll<{ own: string | null }>('/api/start', 15000).data?.own;
  const who = { owner, own };
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const decide = async (h: Hold, verb: 'approve' | 'reject' | 'settle') => {
    setBusy(h.id); setErr(null); setDone(null);
    try {
      const r = await api<Hold>(`/api/holds/${encodeURIComponent(h.id)}/${verb}`, { method: 'POST' });
      if (['failed', 'unknown', 'executing'].includes(r.status)) setErr(`${human(r.method)}: ${HOLD_STATUS[r.status]}.`);
      else if (r.paypal) setDone(`Approved. PayPal made refund ${r.paypal.id}${r.paypal.status ? `, status ${r.paypal.status}` : ''}.`);
    }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(null); reload(); }
  };

  const split = splitHolds(data ?? []);
  const { pending, unconfirmed } = split;
  const shown = all ? pending : pending.slice(0, SHOW);
  const target = (h: Hold) => h.args?.dispute_id
    ? <button type="button" className="jd-linkish jd-id" onClick={() => selectCase(h.args.dispute_id)}>{h.args.dispute_id}</button>
    : h.args?.capture_id ? <span className="jd-id">{h.args.capture_id}</span>
    : h.args?.invoice_id ? <span className="jd-id">{h.args.invoice_id}</span> : <span className="jd-muted">the store</span>;
  const amount = (h: Hold) => { const a = h.args?.offer_amount ?? h.args?.amount; return a?.value ? `${money(Number(a.value), a.currency_code).replace(/[^\d.,]/g, '')} ${a.currency_code}` : '-'; };

  return (
    <Panel
      hug
      title="Waiting for your OK"
      subtitle={data ? holdsLine(split) : 'Loading'}
      action={pending.length > SHOW ? <button type="button" className="jd-linkish jd-muted" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `View all ${pending.length}`}</button> : undefined}
    >
      {error && <div className="jd-result jd-err">{error}</div>}
      {err && <div className="jd-result jd-err">{err}</div>}
      {done && <div className="jd-result jd-ok" role="status">{done}</div>}
      {data && !pending.length && <p className="jd-muted jd-holds-none">No moves waiting. JUNCO holds proposed money moves here.</p>}
      {shown.length > 0 && (
        <table className="jd-table jd-holds">
          <thead><tr><th>Move</th><th>Payment or case</th><th className="jd-r">Amount</th><th>Why it's held</th><th /></tr></thead>
          <tbody>
            {shown.map((h) => (
              <Fragment key={h.id}>
                <tr className={h.recheck ? 'jd-has-note' : undefined}>
                  <td>{human(h.method).replace(/^./, (c) => c.toUpperCase())}{h.asked_by && <div className="jd-sub">Asked by the {h.asked_by}</div>}</td>
                  <td>{target(h)}</td>
                  <td className={amount(h) === '-' ? 'jd-r jd-num jd-no-amount' : 'jd-r jd-num'}>{amount(h)}</td>
                  <td>{h.recheck ? <span className="jd-flag">Re-check</span> : <span className="jd-muted">{policyWords(h.reason)}</span>}</td>
                  <td className="jd-r">{canDecide(h, who) ? <div className="jd-actions">
                    <button type="button" className="jd-btn jd-btn-sm" disabled={busy === h.id} onClick={() => decide(h, 'reject')}>Reject</button>
                    <button type="button" className="jd-btn jd-btn-sm jd-primary" disabled={busy === h.id} onClick={() => decide(h, 'approve')}>{approveLabel(h.method)}</button>
                  </div> : <span className="jd-muted jd-owner-decides" title="Only the store owner approves or rejects this. You decide holds on the case you take in Dispute this store.">Owner decides</span>}</td>
                </tr>
                {/* The re-check reason in full, on its own line under the row, so the buttons keep their place. */}
                {h.recheck && <tr className="jd-note-row"><td colSpan={5}><span className="jd-attn">Re-check:</span> PayPal says this {h.args?.capture_id ? 'payment' : 'case'} changed since it was held ({h.recheck.event}). {h.recheck.refund ? `PayPal reported refund ${h.recheck.refund.id} on it, so approving will refuse this.` : 'Approving re-reads it first.'}</td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {unconfirmed.length > 0 && (
        <div className="jd-unconfirmed">
          <h3>Approved, not confirmed by PayPal</h3>
          {unconfirmed.map((h) => (
            <div key={h.id} className="jd-unconfirmed-row">
              <span>{human(h.method).replace(/^./, (c) => c.toUpperCase())} on {target(h)}</span>
              <span className={h.status === 'failed' ? 'jd-danger' : 'jd-muted'}>{(HOLD_STATUS[h.status] ?? h.status).replace(/^./, (c) => c.toUpperCase())}. It won't be sent again.</span>
              {canDecide(h, who) && <button type="button" className="jd-btn jd-btn-sm" disabled={busy === h.id} onClick={() => decide(h, 'settle')}>Re-check PayPal</button>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
