// RECONCILIATION (Oct 29): the refunds PayPal shows on an incident's payment, lined up against the desk's own holds for it.
// A refund the desk ran is matched by PayPal's refund id, which its hold keeps. Every line is matched, at PayPal only or on
// the desk only, and its source names the record it came from; no model. PayPal's GET comes from the caller (the desk and
// the connector servers), so this file and incident.ts hold no PayPal client. Reads are cached a minute per capture and
// give up after 8 s: an incident page view can't hammer PayPal, and a failure is one line, not a broken page.
// The capture doesn't list its refunds (its only refund link is the POST); its order does, each with an `up` link to it.
import type { Hold } from './gate.js';
import type { IncidentEvent } from './incident-types.js';

export type PayPalGet = (path: string) => Promise<{ status: number; body: any }>;
type Read = { at: string; status?: string; refunds?: { id: string; amount: any; status: string }[]; error?: string };

const TTL = 60_000;
const cache = new Map<string, { t: number; read: Promise<Read> }>(); // ponytail: one entry per capture ever read, fine at desk scale
const money = (a: any) => `${a?.value} ${a?.currency_code ?? 'USD'}`;
const said = (h: Hold) => (h.args?.amount?.value ? `a refund of ${money(h.args.amount)}` : 'a full refund');
const refundId = (h: Hold) => { try { return JSON.parse(h.result ?? '{}')?.id as string | undefined; } catch { return undefined; } };
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
    return { at, status: `${c.body.status}${why ? `: ${why}` : ''}`, refunds: mine.map((r: any) => ({ id: String(r.id), amount: r.amount, status: String(r.status) })) };
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('no answer within 8 s')), 8000); });
  try { return await Promise.race([read(), late]); } catch (e: any) { return { at, error: e.message }; } finally { clearTimeout(timer); }
}

// holds: the incident's own (on its capture or its dispute). Returns one line for the read, then one per money movement.
export async function reconcile(capture_id: string, holds: Hold[], get: PayPalGet): Promise<IncidentEvent[]> {
  let c = cache.get(capture_id);
  if (!c || Date.now() - c.t > TTL) cache.set(capture_id, c = { t: Date.now(), read: readPayPal(capture_id, get) });
  const pp = await c.read;
  const ev = (id: string, source: string, summary: string, ref?: IncidentEvent['ref']): IncidentEvent =>
    ({ id: `reconciliation:${id}`, at: pp.at, kind: 'reconciliation', mode: pp.error ? 'recorded' : 'live', actor: 'JUNCO (system)', source, summary, ref: { capture_id, ...ref } });
  if (!pp.refunds) return [ev('read', 'PayPal', `PayPal didn't answer (${pp.error}), so the refunds on this payment were not checked against the desk.`)];

  const mine = holds.filter((h) => h.method === 'create_refund' && h.args?.capture_id === capture_id);
  const ran = mine.filter((h) => h.status === 'completed'), atPayPal = new Set(pp.refunds.map((r) => r.id));
  const notSent = mine.filter((h) => h.status === 'rejected' || h.status === 'expired');
  const settled = holds.filter((h) => h.status === 'completed' && (h.method === 'accept_dispute_claim' || h.method === 'make_dispute_offer'));
  const n = pp.refunds.length;
  const out = [ev('read', 'PayPal', `PayPal shows ${n || 'no'} refund${n === 1 ? '' : 's'} on this payment, and lists the payment as ${pp.status}.${!n && !ran.length ? ' The desk ran none, so the two agree.' : ''}`)];
  for (const r of pp.refunds) {
    const h = ran.find((x) => refundId(x) === r.id);
    if (h) { out.push(ev(r.id, 'PayPal + holds', `PayPal shows refund ${r.id} for ${money(r.amount)} (${r.status}). The desk made it: hold ${h.id}, approved by the owner.`, { refund_id: r.id, hold_id: h.id })); continue; }
    const same = notSent.find((x) => Number(x.args?.amount?.value) === Number(r.amount?.value));
    out.push(ev(r.id, 'PayPal', `PayPal shows a refund of ${money(r.amount)} (${r.id}, ${r.status}) that the desk has no record of.`
      + (same ? ` Hold ${same.id} asked for the same amount, but it was ${same.status} and never sent.` : '')
      + (settled.length ? ` The desk did run ${settled.map((x) => `${x.method.replace(/_/g, ' ')} (hold ${x.id})`).join(', ')} on this payment's dispute, and PayPal pays a settled dispute back as a refund whose id the desk doesn't keep.` : ''),
      { refund_id: r.id, ...(same && { hold_id: same.id }) }));
  }
  for (const h of ran.filter((x) => !atPayPal.has(refundId(x) ?? ''))) {
    const id = refundId(h);
    out.push(ev(h.id, 'holds', `The desk says hold ${h.id} ran ${said(h)}${id ? ` (PayPal refund ${id})` : ''}, but PayPal doesn't show it on this payment.`, { hold_id: h.id, ...(id && { refund_id: id }) }));
  }
  return out;
}
