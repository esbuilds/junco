import { useEffect, useState } from 'react';
import { selectCase, usePoll } from '../store';

// Judges' "Start here": steps worked out live by the desk (/api/start), so it never names a stale case.
type Start = { hold: { id: string; dispute_id: string; method: string } | null; refusal: string | null; replay: string | null; orders: number };
const KEY = 'jd-start-dismissed';
const WANTS: Record<string, string> = { accept_dispute_claim: 'accept the claim', make_dispute_offer: 'make an offer', create_refund: 'issue a refund', provide_dispute_evidence: 'submit evidence' };
const seen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

export function StartHere({ go }: { go: (page: string) => void }) {
  const [open, setOpen] = useState(() => !seen());
  const { data } = usePoll<Start>(open ? '/api/start' : null, 15000);
  useEffect(() => { if (!open) try { localStorage.setItem(KEY, '1'); } catch { /* private mode: just close */ } }, [open]);
  const openCase = (id: string) => { go('desk'); selectCase(id); setOpen(false); };

  const steps: [string, string, () => void][] = [];
  if (data?.refusal) steps.push(['See it refuse', `Open ${data.refusal}. JUNCO says not to fight this one and names the proof that would change its mind.`, () => openCase(data.refusal!)]);
  if (data?.hold) steps.push(['Approve or reject', `JUNCO wants to ${WANTS[data.hold.method] ?? data.hold.method.replace(/_/g, ' ')} on ${data.hold.dispute_id} and is waiting for you. Money only moves with your OK.`, () => openCase(data.hold!.dispute_id)]);
  if (data?.replay) steps.push(['Watch the agent work', `Open ${data.replay} and press "Replay what JUNCO did": its real log, step by step.`, () => openCase(data.replay!)]);
  steps.push(['Before any dispute', data?.orders ? `Orders: ${data.orders} paid order${data.orders === 1 ? '' : 's'} watched until they have tracking.` : 'Orders: every paid order is watched until it has tracking, before any dispute.', () => { go('orders'); setOpen(false); }]);
  steps.push(['Your rules', 'Policy: what JUNCO may do on its own, and what always waits for you.', () => { go('policy'); setOpen(false); }]);

  return (
    <>
      <button type="button" className="jd-tab" aria-expanded={open} onClick={() => setOpen(!open)}>Start here</button>
      {open && (
        <div className="jd-start" role="dialog" aria-label="Start here">
          <div className="jd-start-head"><strong>Start here</strong><span className="jd-muted">Everything runs on the PayPal sandbox.</span>
            <button type="button" className="jd-btn" onClick={() => setOpen(false)}>Close</button></div>
          <ol>
            {steps.map(([title, text, run], i) => (
              <li key={title}><button type="button" className="jd-start-step" onClick={run}><span className="jd-start-n">{i + 1}</span><span><strong>{title}</strong><span className="jd-muted">{text}</span></span></button></li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}
