// BLACK BOX, the judge's first questions about an incident, answered from the Incident JSON alone (no model, no
// PayPal). Shared by the desk's server code and Studio; public/incident.html repeats these few lines in plain JS.
import type { BooksRow, Incident, IncidentEvent, Match, Mode, ThreeRecords } from './incident-types.js';

// Ids in running text, set in mono so a sentence reads past them: PayPal's dispute, capture and refund ids, and a hold's short id.
export const ID_TOKEN = /\b(?:PP-[A-Z0-9-]{6,}|(?=[A-Z]*\d)[A-Z0-9]{13,}|(?=[a-f]*\d)[0-9a-f]{8})\b/g;

// The AI's own words (a refund ask's support agent) are often markdown. Shown as plain text, at display time only: bold,
// underline and code marks dropped, each list item or paragraph its own line. Never HTML; callers escape as before.
export const aiLines = (s: string) => s.split(/\n+|\s+-\s+(?=\*\*)/) // a list run onto one line: " - **Label:**"
  .map((l) => l.replace(/\*\*|__|`/g, '').replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/^#+\s*/, '').trim()).filter(Boolean);
// One line for a rail summary: a space after a sentence or a label, "; " otherwise.
export const aiText = (s: string) => aiLines(s).reduce((out, l) => (!out ? l : /[.!?:;]["')]?$/.test(out) ? `${out} ${l}` : `${out}; ${l}`), '');

// The event's own mode (set by src/incident.ts). Events from before it existed fall back to the same rule: PayPal's
// events and a gate call the gate allowed ("allow:") are LIVE; the desk's own decisions and a case lease are RECORDED.
// WHAT-IF never appears on an event; whatIf() returns it and the page draws it apart.
const LIVE = new Set<IncidentEvent['kind']>(['purchase', 'payment', 'dispute', 'paypal', 'webhook']);
export const modeOf = (e: IncidentEvent): Mode => e.mode ?? ((LIVE.has(e.kind) && !e.id.endsWith(':leased')) || (e.kind === 'gate' && !!e.ref?.rule?.startsWith('allow:')) ? 'live' : 'recorded');

// The Books' order: differences pinned first, then what went unread, newest first within each. Studio's filters hand back
// rows in their own order, so the widget sorts with this too.
const RANK = { Differ: 0, Unread: 1, Agree: 2 };
type Ranked = Pick<BooksRow, 'reconciliation' | 'at' | 'purchase'>;
export const byDifference = (a: Ranked, b: Ranked) => RANK[a.reconciliation] - RANK[b.reconciliation] || b.at.localeCompare(a.at) || a.purchase.localeCompare(b.purchase);

// What the AI believed, what the gate recorded and what PayPal says, on one purchase. A dispute hold and a settled dispute's
// refund aren't differences, and PayPal not answering is never agreement. The AI's and the gate's are the desk's own records,
// so RECORDED; PayPal's is LIVE only when it answered this read.
const ROW: Partial<Record<Match, string>> = { matched: 'Refund', settled: 'Refund', paypal_only: 'Refund', dispute_hold: 'Dispute hold', desk_only: 'Not at PayPal' };
export function threeRecords(inc: Incident): ThreeRecords | null {
  const p = inc.purchase, c = inc.counts;
  if (!p) return null;
  const read = inc.events.find((e) => e.id === 'reconciliation:read'), fp = inc.events.find((e) => e.kind === 'paypal_fingerprint');
  const lines = inc.events.filter((e) => e.kind === 'reconciliation' && e !== read), answered = !!read && read.match !== 'unread';
  const differ = [...lines.filter((e) => e.match === 'paypal_only' || e.match === 'desk_only').map((e) => e.summary), ...(fp?.match === 'fingerprint_mismatch' ? [fp.summary] : []),
    ...(c.outcome_unknown ? [`The gate doesn't know how ${c.outcome_unknown} money move${c.outcome_unknown === 1 ? '' : 's'} ended.`] : [])];
  const held = lines.some((e) => e.match === 'dispute_hold');
  const line = differ.length ? `The records differ. ${differ.join(' ')}`
    : !read ? "PayPal wasn't read for this purchase, so the three records can't be compared."
    : !answered ? "PayPal didn't answer, so the three records can't be compared right now."
    : `The three records agree.${held ? " PayPal's dispute hold on this payment isn't a difference: no money has gone back." : ''}`;
  const holds = inc.events.filter((e) => e.kind === 'hold').map((e) => {
    const id = e.ref?.hold_id, end = inc.events.find((x) => x.id === `paypal:${id}`) ?? inc.events.find((x) => x.id === `approval:${id}`);
    return { label: `Hold ${id}`, value: end?.summary ?? 'Waiting for the owner.' };
  });
  return { agree: differ.length ? false : answered ? true : null, line, columns: [
    { title: 'What the AI believed', mode: 'recorded', rows: [{ label: 'Asked', value: inc.authority?.instruction ?? 'not in the records' }, { label: 'Budget', value: inc.authority?.budget ?? 'not in the records' },
      { label: 'Bought', value: `${p.sku} for ${p.amount}` }, { label: 'Its reason', value: p.reason }, ...(inc.photo ? [{ label: "The buyer's photo", value: 'Sent with the refund ask, unverified' }] : [])] },
    { title: 'What the gate recorded', mode: 'recorded', rows: [{ label: 'Proposed', value: String(c.proposed) }, { label: 'Approved', value: String(c.approved) }, ...(c.demo_approved ? [{ label: 'Approved by the demo approver', value: String(c.demo_approved) }] : []), ...(c.leased_approved ? [{ label: 'Approved by a visitor on their leased case', value: String(c.leased_approved) }] : []), { label: 'Executed', value: String(c.executed) },
      ...(c.outcome_unknown ? [{ label: 'Outcome unknown', value: String(c.outcome_unknown) }] : []), ...(holds.length ? holds : [{ label: 'Holds', value: 'None' }])] },
    { title: 'What PayPal says', mode: answered ? 'live' : 'recorded', rows: [{ label: 'Payment', value: read?.summary ?? 'Not read.' },
      ...lines.map((e) => ({ label: ROW[e.match!] ?? 'Line', value: e.summary })),
      ...inc.events.filter((e) => e.kind === 'outside_refund').map((e) => ({ label: 'Webhook', value: e.summary })),
      { label: 'Fingerprint', value: fp?.summary ?? 'Not recorded at PayPal (placed before fingerprints).' }] },
  ] };
}

// The one line a reader should take first: what the agent bought, for how much, and how it ended, from the records alone.
// public/incident.html repeats this body in plain JS (check-incident-desk compares them).
export const verdict = (inc: Incident) => {
  const p = inc.purchase;
  if (!p) return 'The agent bought nothing.';
  const item = p.listing.startsWith(`${p.sku} `) ? p.listing.split(',')[0] : p.sku;
  const read = inc.events.find((e) => e.id === 'reconciliation:read'), status = read?.ref?.payment_status;
  const back = inc.events.filter((e) => e.kind === 'reconciliation' && ['matched', 'settled', 'paypal_only'].includes(e.match ?? '')).map((e) => e.ref?.amount);
  const waiting = inc.events.some((e) => e.kind === 'hold' && !inc.events.some((x) => x.id === `approval:${e.ref?.hold_id}`));
  const ends = [inc.dispute_id && 'the buyer disputed it', back.length && `PayPal shows ${back.join(' and ')} refunded`, waiting && 'a held action is waiting for the owner',
    inc.counts.outcome_unknown && 'a money move ended with its outcome unknown'].filter(Boolean);
  if (!read || read.match === 'unread') ends.push(`PayPal ${read ? "didn't answer" : "wasn't read"}, so how it ended isn't confirmed`);
  else if (!ends.length) ends.push(status === 'COMPLETED' ? 'PayPal shows it paid, with no dispute or refund on record' : `PayPal lists the payment as ${status}`);
  return `The agent bought ${item} for ${p.amount}, and ${ends.length > 1 ? `${ends.slice(0, -1).join(', ')} and ${ends[ends.length - 1]}` : ends[0]}.`;
};

// "Which actions reached PayPal?": the LIVE events, to highlight.
export function reachedPayPal(inc: Incident) {
  const ids = inc.events.filter((e) => modeOf(e) === 'live').map((e) => e.id), n = inc.events.length;
  return { ids, text: ids.length ? `${ids.length} of ${n} events reached PayPal or came from it (LIVE). The other ${n - ids.length} stayed inside the desk.` : 'Nothing in this incident reached PayPal.' };
}

// "What's not in the records?": the missing list, or how many recorded facts there are when nothing is missing.
export function notInRecords(inc: Incident) {
  const facts = inc.events.length + Object.values(inc.authority ?? {}).filter(Boolean).length + Object.values(inc.purchase ?? {}).filter(Boolean).length + (inc.dispute_id ? 1 : 0);
  return { missing: inc.missing, text: inc.missing.length ? `${inc.missing.length} thing${inc.missing.length === 1 ? ' is' : 's are'} not in the records, listed as missing, never filled in.` : `Nothing missing. ${facts} facts on record checked.` };
}

// "What if the refund limit were $X?": X is the purchase amount less $10, re-run on the recorded money moves newest
// first (the caller tries each until one has an amount limit to change). None recorded: say how one gets proposed.
export const NOTHING_PROPOSED = 'Nothing was proposed yet, so there is no recorded request to re-run. To get one: connect Claude to JUNCO, ask it for a refund on this order, and it waits here as a hold for the owner.';
// A decline has no order: the page and Studio hide the what-if for it; this text is the answer if anything still asks.
export const NOTHING_BOUGHT = 'The agent bought nothing, so there is no order, no payment and no money move to re-run.';
export function whatIfPreset(inc: Incident) {
  const amount = parseFloat(inc.purchase?.amount ?? '');
  const limit = Number.isFinite(amount) ? Math.max(0, Math.round((amount - 10) * 100) / 100) : 0;
  const targets = inc.events.filter((e) => e.kind === 'hold' || e.kind === 'gate').reverse().map((e) => e.id);
  return { limit, label: `What if the refund limit were $${limit}?`, targets, none: inc.decline ? NOTHING_BOUGHT : targets.length ? null : NOTHING_PROPOSED };
}
