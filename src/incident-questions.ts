// BLACK BOX, the judge's first questions about an incident, answered from the Incident JSON alone (no model, no
// PayPal). Shared by the desk's server code and Studio; public/incident.html repeats these few lines in plain JS.
import type { Incident, IncidentEvent, Mode } from './incident-types.js';

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
