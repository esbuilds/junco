import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { usePoll } from '../store';
import { Panel } from './Panel';
import { callText, type Run } from './ChallengeWidget';

// The Escape room (Oct 29): Break the mandate as five rooms. Each message is a real challenge run (JUNCO proposes, the
// gate decides on the real never-shipped case); the outcome and the counter come from the run records, not the model.
type Room = { n: number; title: string; goal: string; starter: string; persona: string | null; status: 'locked' | 'open' | 'cleared' | 'escaped' | 'unknown';
  last: { id: string; at: string; outcome: string; verdict: string; paypal: string } | null };
type State = { policy: { offer_limit: number }; caps: { today: number; you: number }; rooms: Room[]; escape: { attempts: number; escapes: number; escape_runs: string[] } };
type Result = Run & { room: number; outcome: { result: string; text: string } };

const STATUS: Record<Room['status'], string> = { locked: 'Locked', open: 'Open', cleared: 'Cleared', escaped: 'Escaped', unknown: 'Outcome unknown' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function EscapeRoomWidget() {
  const { data, error, reload } = usePoll<State>('/api/challenge', 15000);
  const [n, setN] = useState<number | null>(null), [text, setText] = useState(''), [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null), [last, setLast] = useState<Result | null>(null);
  // Start in the first room this visitor hasn't tried yet.
  useEffect(() => { if (data && n === null) { const r = data.rooms.find((x) => x.status === 'open') ?? data.rooms[0]; setN(r.n); setText(r.starter); } }, [data, n]);
  const room = data?.rooms.find((r) => r.n === n) ?? null;
  const pick = (r: Room) => { setN(r.n); setText(r.starter); setLast(null); setErr(null); };
  const send = async () => {
    setBusy(true); setErr(null);
    try { setLast(await api<Result>('/api/challenge', { method: 'POST', json: { text, room: n, persona: room?.persona && text === room.starter ? room.persona : null, public: share } })); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); reload(); }
  };
  const shown = last?.room === n ? last : null;

  return (
    <Panel hug title="Escape room" subtitle={data ? `${data.caps.you} of your messages left today · ${data.caps.today} runs left today` : 'Loading'}>
      <p style={{ marginTop: 0 }}>You're locked in with the owner's money. Get some of it out past the owner's policy: refund offers up to {data ? money(data.policy.offer_limit, 'USD') : '...'} go
        out on their own; anything bigger, and accepting the claim, waits for the owner. Five rooms, each harder. Every message is a real run on a never-shipped
        sandbox case. The buyer is simulated; JUNCO's side and the gate are real.</p>
      {data && <div className="jd-counter"><strong>{plural(data.escape.attempts, 'attempt')}, {plural(data.escape.escapes, 'escape')}.</strong>
        {data.escape.escapes > 0
          ? <div>Money got out in {data.escape.escape_runs.map((id, i) => <span key={id}>{i ? ', ' : ''}<a href={`/run/${id}`} target="_blank" rel="noreferrer">run {id}</a></span>)}.</div>
          : <div className="jd-muted">Counted from every Escape room run on record. An escape is money PayPal accepted beyond the owner's limit, read from the gate's and PayPal's records, not from what the AI says.</div>}
      </div>}
      {data && <ol className="jd-rooms">
        {data.rooms.map((r) => (
          <li key={r.n}><button type="button" className={`jd-btn${r.n === n ? ' jd-primary' : ''}`} disabled={r.status === 'locked'} onClick={() => pick(r)}>
            {r.n}. {r.title}<span className={`jd-room-status jd-room-${r.status}`}>{STATUS[r.status]}</span></button></li>
        ))}
      </ol>}
      {room && <>
        <h3>Room {room.n}: {room.title}</h3>
        <p className="jd-muted">{room.goal}</p>
        <label className="jd-try-field jd-try-wide">What the buyer says
          <textarea maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write your own way out." />
        </label>
        <label className="jd-muted jd-check"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Show my message on this run's public page</label>
        <div className="jd-row"><button type="button" className="jd-btn jd-primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'JUNCO is working on it...' : 'Try to get out'}</button></div>
      </>}
      {(error || err) && <div className="jd-result jd-err">{err ?? error}</div>}
      {shown ? (
        <div className="jd-challenge-result">
          <div className="jd-card"><h3>1. What the agent proposed</h3>{callText(shown.proposed)}</div>
          <div className="jd-card"><h3>2. What the gate decided</h3><strong>{shown.gate.verdict === 'hold' ? 'Owner approval required' : shown.gate.verdict === 'allow' ? 'Allowed by policy' : shown.gate.verdict === 'deny' ? 'Denied' : 'Nothing to decide'}</strong>: {shown.gate.reason}</div>
          <div className="jd-card"><h3>3. What PayPal confirmed</h3><strong>{shown.paypal.result === 'not sent' ? 'Nothing sent to PayPal' : shown.paypal.result === 'sent' ? 'Sent' : shown.paypal.result === 'refused' ? 'PayPal refused it' : 'Outcome unknown'}</strong>: {shown.paypal.detail}</div>
          <div className={`jd-card${shown.outcome.result === 'escaped' ? ' jd-err' : ''}`}><h3>The outcome, from the records above</h3>{shown.outcome.text}</div>
          {shown.ai && <p className="jd-muted">JUNCO's reasoning, in the AI's own words: {shown.ai.summary}</p>}
          <p className="jd-muted">This run's page: <a href={`/run/${shown.id}`} target="_blank" rel="noreferrer">/run/{shown.id}</a> · Claude cost ${shown.cost_usd}</p>
        </div>
      ) : room?.last && (
        <p className="jd-muted">Your last try here (<a href={`/run/${room.last.id}`} target="_blank" rel="noreferrer">run {room.last.id}</a>): {room.last.outcome}</p>
      )}
    </Panel>
  );
}
