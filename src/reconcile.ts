// RECONCILIATION (Oct 29): the refunds PayPal shows on an incident's payment, lined up against the desk's own holds for it.
// A refund the desk ran is matched by PayPal's refund id, which its hold keeps. Every line is matched, at PayPal only or on
// the desk only, and its source names the record it came from; no model. PayPal's GET comes from the caller (the desk and
// the connector servers), so this file and incident.ts hold no PayPal client. Reads are cached a minute per capture and
// give up after 8 s: an incident page view can't hammer PayPal, and a failure is one line, not a broken page.
// The capture doesn't list its refunds (its only refund link is the POST); its order does, each with an `up` link to it.
// PayPal's dispute hold (Oct 30): on a disputed payment the order lists a PENDING refund entry for the purchase minus PayPal's
// fee, with nothing refunded. No money has moved, so it gets its own line and is never counted as a mismatch.
// A line's `match` says what it found, for code; its summary says it for people. An outside refund alert reads the same lines
// (outside-refund.ts), so the page and the alert can't disagree.
import type { Hold, Move } from './gate.js';
import type { IncidentEvent, Match } from './incident-types.js';

export type PayPalGet = (path: string) => Promise<{ status: number; body: any }>;
type Refund = { id: string; amount: any; status: string; refunded?: any };
type Read = { at: string; status?: string; refunds?: Refund[]; error?: string };

// PayPal's refund id and status from a hold's stored result. The result is the tool's text: PayPal's JSON, sometimes
// wrapped (hosted MCP content, or a settle's `was`), sometimes prose. Null when no refund id is in it.
export function paypalRefund(h: { method: string; result?: string }): { id: string; status: string | null } | null {
  if (!/refund/.test(h.method) || !h.result) return null;
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  const find = (o: any): { id: string; status: string | null } | null => {
    if (typeof o === 'string') { const p = parse(o); return p === undefined ? null : find(p); }
    if (!o || typeof o !== 'object' || o.error) return null;
    if (typeof o.id === 'string' && !Array.isArray(o)) return { id: o.id, status: typeof o.status === 'string' ? o.status : null };
    for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
    return null;
  };
  const r = find(h.result);
  if (r || parse(h.result) !== undefined) return r;
  const id = h.result.match(/\bid\W{1,4}([0-9A-Z]{10,30})\b/i)?.[1]; // prose: "Refund id: 1AB23..."
  return id ? { id, status: h.result.match(/\bstatus\W{1,4}([A-Z_]{4,})\b/)?.[1] ?? null } : null;
}

const TTL = 60_000;
const cache = new Map<string, { t: number; read: Promise<Read> }>(); // ponytail: one entry per capture ever read, fine at desk scale
const money = (a: any) => `${a?.value} ${a?.currency_code ?? 'USD'}`;
const said = (h: Hold) => (h.args?.amount?.value ? `a refund of ${money(h.args.amount)}` : 'a full refund');
const refundId = (h: Hold) => paypalRefund(h)?.id;
const path = (href: string) => new URL(href).pathname;

async function readPayPal(capture_id: string, get: PayPalGet): Promise<Read> {
  const at = new Date().toISOString();
  const read = async (): Promise<Read> => {
    const c = await get(`/v2/payments/captures/${encodeURIComponent(capture_id)}`);
    if (c.status !== 200) throw new Error(`the capture read returned ${c.status}`);
    const up = c.body.links?.find((l: any) => l.rel === 'up')?.href;
    if (!up) throw new Error('the capture names no order to read its refunds from');
    const o = await get(path(up));
    if (o.status !== 200) throw new Error(`the order read returned ${o.status}`);
    const all = (o.body.purchase_units ?? []).flatMap((u: any) => u.payments?.refunds ?? []);
    const mine = all.filter((r: any) => { const u = r.links?.find((l: any) => l.rel === 'up')?.href; return !u || path(u).endsWith(`/captures/${capture_id}`); });
    const why = c.body.status_details?.reason;
    return { at, status: `${c.body.status}${why ? `: ${why}` : ''}`, refunds: mine.map((r: any) => ({ id: String(r.id), amount: r.amount, status: String(r.status), refunded: r.seller_payable_breakdown?.total_refunded_amount })) };
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('no answer within 8 s')), 8000); });
  try { return await Promise.race([read(), late]); } catch (e: any) { return { at, error: e.message }; } finally { clearTimeout(timer); }
}

// PayPal just said this payment changed, so the next read goes to PayPal.
export const forget = (capture_id: string) => cache.delete(capture_id);

// holds and moves: the incident's own (on its capture or its dispute). moves is the gate log: a move the gate allowed has no
// hold. decider: who approved a hold, the owner unless the caller knows better. Returns one line for the read, then one per
// money movement.
export async function reconcile(capture_id: string, holds: Hold[], get: PayPalGet, moves: Move[] = [], decider: (id: string) => string = () => 'the owner'): Promise<IncidentEvent[]> {
  let c = cache.get(capture_id);
  if (!c || Date.now() - c.t > TTL) cache.set(capture_id, c = { t: Date.now(), read: readPayPal(capture_id, get) });
  const pp = await c.read;
  const ev = (id: string, source: string, summary: string, ref?: IncidentEvent['ref'], match?: Match): IncidentEvent =>
    ({ id: `reconciliation:${id}`, at: pp.at, kind: 'reconciliation', mode: pp.error ? 'recorded' : 'live', actor: 'JUNCO (system)', source, summary, ref: { capture_id, ...ref }, ...(match && { match }) });
  if (!pp.refunds) return [ev('read', 'PayPal', `PayPal didn't answer (${pp.error}), so the refunds on this payment were not checked against the desk.`, undefined, 'unread')];

  const mine = holds.filter((h) => h.method === 'create_refund' && h.args?.capture_id === capture_id);
  const ran = mine.filter((h) => h.status === 'completed'), atPayPal = new Set(pp.refunds.map((r) => r.id));
  const notSent = mine.filter((h) => h.status === 'rejected' || h.status === 'expired');
  const passed = moves.filter((m) => m.verdict === 'allow' && !m.error), sent = passed.filter((m) => m.method === 'create_refund' && m.args?.capture_id === capture_id);
  const settled = [...holds.filter((h) => h.status === 'completed' && (h.method === 'accept_dispute_claim' || h.method === 'make_dispute_offer')).map((x) => `${x.method.replace(/_/g, ' ')} (hold ${x.id})`),
    ...passed.filter((m) => m.method === 'accept_dispute_claim' || m.method === 'make_dispute_offer').map((m) => `${m.method.replace(/_/g, ' ')} (allowed by the gate)`)];
  // ponytail: no refunded figure means no hold, so a shape change at PayPal shows up as a mismatch and never hides money moved
  const disputeHold = (r: Refund) => pp.status === 'PENDING: BUYER_COMPLAINT' && r.status === 'PENDING' && Number(r.refunded?.value) === 0 && !ran.some((x) => refundId(x) === r.id);
  const n = pp.refunds.filter((r) => !disputeHold(r)).length;
  const out = [ev('read', 'PayPal', `PayPal shows ${n || 'no'} refund${n === 1 ? '' : 's'} on this payment${n < pp.refunds.length ? ' apart from a dispute hold' : ''}, and lists the payment as ${pp.status}.${!n && !ran.length ? ' The desk ran none, so the two agree.' : ''}`, { payment_status: pp.status })];
  for (const r of pp.refunds) {
    const h = ran.find((x) => refundId(x) === r.id);
    if (h) { out.push(ev(r.id, 'PayPal + holds', `PayPal shows refund ${r.id} for ${money(r.amount)} (${r.status}). The desk made it: hold ${h.id}, approved by ${decider(h.id)}.`, { refund_id: r.id, amount: money(r.amount), hold_id: h.id }, 'matched')); continue; }
    if (disputeHold(r)) { out.push(ev(r.id, 'PayPal', `PayPal's record reads as a dispute hold of ${money(r.amount)}: entry ${r.id} is ${r.status} on a payment held for a buyer complaint, and PayPal records ${money(r.refunded)} refunded, so no money has gone back to the buyer. The desk has nothing to match here.`, { refund_id: r.id, amount: money(r.amount) }, 'dispute_hold')); continue; }
    // ponytail: the gate log keeps no refund id, so this matches by amount, each allowed move once; save the id if allowing refunds ever becomes common
    const m = sent.findIndex((x) => !x.args?.amount?.value || Number(x.args.amount.value) === Number(r.amount?.value));
    if (m >= 0) { const [x] = sent.splice(m, 1); out.push(ev(r.id, 'PayPal + gate log', `PayPal shows refund ${r.id} for ${money(r.amount)} (${r.status}). The gate allowed a refund of that amount on this payment (${x.reason}); its log keeps no PayPal id, so this is matched by amount.`, { refund_id: r.id, amount: money(r.amount) }, 'matched')); continue; }
    const same = notSent.find((x) => Number(x.args?.amount?.value) === Number(r.amount?.value));
    out.push(ev(r.id, 'PayPal', `PayPal shows a refund of ${money(r.amount)} (${r.id}, ${r.status}) that the desk has no record of.`
      + (same ? ` Hold ${same.id} asked for the same amount, but it was ${same.status} and never sent.` : '')
      + (settled.length ? ` The desk did run ${settled.join(', ')} on this payment's dispute, and PayPal pays a settled dispute back as a refund whose id the desk doesn't keep.` : ''),
      { refund_id: r.id, amount: money(r.amount), ...(same && { hold_id: same.id }) }, settled.length ? 'settled' : 'paypal_only'));
  }
  for (const h of ran.filter((x) => !atPayPal.has(refundId(x) ?? ''))) {
    const id = refundId(h);
    out.push(ev(h.id, 'holds', `The desk says hold ${h.id} ran ${said(h)}${id ? ` (PayPal refund ${id})` : ''}, but PayPal doesn't show it on this payment.`, { hold_id: h.id, ...(id && { refund_id: id }) }, 'desk_only'));
  }
  return out;
}
