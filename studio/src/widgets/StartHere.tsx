import { useState } from 'react';
import { usePoll } from '../store';
import { selectCase } from '../store';
import { markOpened, readOpened, startProgress } from '../ui';

// Judges' "Start here", in the Desk's right rail (UI polish): the current step open with its description, the rest one
// line each. Steps follow the judge's 90 seconds and are worked out live by the desk (/api/start), so it never names a
// stale case. Progress is per browser and keyed by position, since step 2's title follows the judge's own case.
type Start = { own: string | null; own_ready: boolean; hold: { id: string; dispute_id: string; method: string } | null; incident: string | null };
const WANTS: Record<string, string> = { accept_dispute_claim: 'accept the claim', make_dispute_offer: 'make an offer', create_refund: 'issue a refund', provide_dispute_evidence: 'submit evidence' };
const scrollTo = (id: string) => setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
const go = (page: string) => window.dispatchEvent(new CustomEvent('jd-go', { detail: page }));

export function StartRail() {
  const { data } = usePoll<Start>('/api/start', 15000);
  const [opened, setOpened] = useState(readOpened);
  const desk = (anchor?: string, id?: string) => () => { go('desk'); if (id) selectCase(id); const to = anchor ?? (id ? 'jd-case' : undefined); if (to) scrollTo(to); };

  // Step 2 is on the judge's own case (v3.12): visitors approve or reject only there.
  const first: [string, string, () => void] = data?.hold && data.hold.dispute_id === data.own
    ? ['Approve or reject', `JUNCO wants to ${WANTS[data.hold.method] ?? data.hold.method.replace(/_/g, ' ')} on ${data.hold.dispute_id}.`, desk(undefined, data.hold.dispute_id)]
    : data?.own ? ['Your case', `${data.own} is yours for 30 minutes.`, desk(undefined, data.own)]
    : ['Get your own case', data?.own_ready ? 'Take "An order that was never shipped" in Dispute this store.' : 'A real sandbox case when one is ready; a recorded run until then.', desk('store-dispute')];
  // BLACK BOX first: the newest AI purchase that was disputed, on the Incident page (it reads ?id= when it mounts).
  const investigate = () => { history.replaceState(null, '', `?page=incident${data?.incident ? `&id=${encodeURIComponent(data.incident)}` : ''}`); go('incident'); };
  const steps: [string, string, () => void][] = [
    ['Investigate an AI purchase', 'What the agent was allowed, and what reached PayPal.', investigate],
    first,
    ['Every money move', 'The Gate record, from every source.', desk('gate-record')],
    ['Change the owner', 'Try a different limit on past actions.', () => go('policy')],
    ['Try to break it', 'Talk JUNCO past the owner\'s limit.', () => go('mandate')],
    ['Test the brain', '43 test cases. Nothing reaches PayPal.', () => go('try')],
  ];
  const keys = steps.map((_, i) => `step-${i + 1}`);
  const { current, done } = startProgress(opened, keys);
  const run = (i: number) => { markOpened(keys[i]); setOpened(readOpened()); steps[i][2](); };

  return (
    <section className="jd-panel jd-start" aria-label="Start here">
      <header className="jd-panel-head"><h2>Start here</h2><span className="jd-muted">{done} of {steps.length}</span></header>
      <ol>
        {steps.map(([title, text], i) => (
          <li key={keys[i]} className={i === current ? 'jd-start-now' : opened.includes(keys[i]) ? 'jd-start-done' : undefined}>
            <span className="jd-start-n" aria-hidden="true">{opened.includes(keys[i]) ? '✓' : i + 1}</span>
            {i === current
              ? <span><strong>{title}</strong><span className="jd-muted">{text}</span><button type="button" className="jd-btn jd-btn-sm" onClick={() => run(i)}>Open</button></span>
              : <button type="button" className="jd-linkish jd-start-step" title={text} onClick={() => run(i)}>{title}</button>}
          </li>
        ))}
      </ol>
    </section>
  );
}
