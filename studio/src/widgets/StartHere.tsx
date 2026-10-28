import { usePoll } from '../store';
import { selectCase } from '../store';

// Judges' "Start here" (v3.14 first screen): a dismissible strip under the header, so the holds and the assistant stay
// visible on load. Steps follow the judge's 90 seconds and are worked out live by the desk (/api/start), so it never
// names a stale case.
type Start = { own: string | null; own_ready: boolean; hold: { id: string; dispute_id: string; method: string } | null; incident: string | null };
const KEY = 'jd-start-dismissed';
const WANTS: Record<string, string> = { accept_dispute_claim: 'accept the claim', make_dispute_offer: 'make an offer', create_refund: 'issue a refund', provide_dispute_evidence: 'submit evidence' };
export const startSeen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const scrollTo = (id: string) => setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);

export function StartHere({ go, close }: { go: (page: string) => void; close: () => void }) {
  const { data } = usePoll<Start>('/api/start', 15000);
  const done = () => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode: just close */ } close(); };
  const desk = (anchor?: string, id?: string) => () => { go('desk'); if (id) selectCase(id); if (anchor) scrollTo(anchor); };

  // Step 1 is on the judge's own case (v3.12): visitors approve or reject only there.
  const first: [string, string, () => void] = data?.hold && data.hold.dispute_id === data.own
    ? ['Approve or reject', `JUNCO wants to ${WANTS[data.hold.method] ?? data.hold.method.replace(/_/g, ' ')} on your case ${data.hold.dispute_id}. Money moves only with your OK.`, desk(undefined, data.hold.dispute_id)]
    : data?.own ? ['Your case', `${data.own} is yours for 30 minutes. If JUNCO holds an action, you decide.`, desk(undefined, data.own)]
    : ['Get your own case', data?.own_ready ? 'Dispute this store: take "An order that was never shipped". JUNCO holds an accept for your OK.' : 'Dispute this store gives you a real sandbox case when one is ready; until then, a recorded run.', desk('store-dispute')];
  // BLACK BOX first: the newest AI purchase that was disputed, on the Incident page (it reads ?id= when it mounts).
  const investigate = () => { history.replaceState(null, '', `?page=incident${data?.incident ? `&id=${encodeURIComponent(data.incident)}` : ''}`); go('incident'); };
  const steps: [string, string, () => void][] = [
    ['Investigate an AI purchase', 'A shopping agent bought it and the buyer disputed it. See what it was allowed, what reached PayPal, and re-run the gate.', investigate],
    first,
    ['Every money move', 'The Gate record: each one any agent proposed, held for the owner, from every source.', desk('gate-record')],
    ['Change the owner', 'Policy: try a different limit and see which past actions would have gone out without you.', () => go('policy')],
    ['Try to break it', 'Break the mandate: talk JUNCO into giving more than the owner allowed.', () => go('mandate')],
    ['Test the brain', 'Try it: 43 test cases or your own message. Nothing reaches PayPal.', () => go('try')],
  ];
  return (
    <div className="jd-strip" role="region" aria-label="Start here">
      <strong>Start here</strong>
      <ol>
        {steps.map(([title, text, run], i) => (
          <li key={title}><button type="button" className="jd-strip-step" title={text} onClick={run}><span className="jd-start-n">{i + 1}</span><span><strong>{title}</strong><span className="jd-muted">{text}</span></span></button></li>
        ))}
      </ol>
      <button type="button" className="jd-btn" onClick={done} aria-label="Close Start here">Close</button>
    </div>
  );
}
