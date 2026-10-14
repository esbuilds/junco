// Shipment watch: dispute prevention. Every captured payment (PAYMENT.CAPTURE.COMPLETED webhook) becomes a watched
// order until it has tracking on PayPal. Code decides the flags from PayPal's own data; Claude only words the reason.
// Rules cite PayPal's Seller Protection page: proof of shipment needs "an online and verifiable tracking number" and the
// item must ship "to the shipping address on the Transaction Details page". The ship-by days are the owner's policy.
import { claude } from './spend.js';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { z } from 'zod';
import { paypal, type Ctx } from './disputes.js';
import { mirror } from './persist.js';

export const SELLER_PROTECTION_PAGE = 'https://www.paypal.com/us/webapps/mpp/ua/seller-protection';
type Flag = { code: 'no_tracking' | 'address_differs' | 'not_eligible'; text: string };
export type Watched = {
  capture_id: string; order_id: string; amount: number; currency: string; captured_at: string; item: string | null;
  ship_to: string | null; ship_postal: string | null; payer_postal: string | null; protection: string | null;
  trackers: { number: string; status: string }[]; flags: Flag[]; status: 'protected' | 'watching' | 'at_risk';
  ship_by: string; reason: string | null; reason_key?: string; checked_at: string;
};

const FILE = '.junco/orders.json';
export const readOrders = (): Record<string, Watched> => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (o: Watched) => { const all = { ...readOrders(), [o.capture_id]: o }; mkdirSync('.junco', { recursive: true }); writeFileSync(FILE, JSON.stringify(all, null, 2)); mirror(FILE, all); return o; };

// Pure: the flags and status for an order at time `now`. check-watch pins the edges.
export function assess(o: Pick<Watched, 'captured_at' | 'trackers' | 'ship_postal' | 'payer_postal' | 'protection'>, shipWithinDays: number, now = Date.now()) {
  const shipBy = new Date(Date.parse(o.captured_at) + shipWithinDays * 86_400_000).toISOString();
  const tracked = o.trackers.some((t) => t.status !== 'CANCELLED');
  const flags: Flag[] = [];
  if (!tracked && now > Date.parse(shipBy)) flags.push({ code: 'no_tracking', text: 'No tracking on PayPal yet. Seller Protection needs a verifiable tracking number as proof of shipment.' });
  if (o.ship_postal && o.payer_postal && o.ship_postal.slice(0, 5) !== o.payer_postal.slice(0, 5))
    flags.push({ code: 'address_differs', text: 'Ship-to ZIP differs from the buyer\'s own address. Ship only to the address on the order.' });
  if (o.protection === 'NOT_ELIGIBLE') flags.push({ code: 'not_eligible', text: 'PayPal marked this payment not eligible for Seller Protection.' });
  const status: Watched['status'] = flags.length ? 'at_risk' : tracked ? 'protected' : 'watching';
  return { flags, status, ship_by: shipBy };
}

// The gated tool the desk uses to add tracking (Orders v2 track; the v1 shipping API is closed to this app, see PLAN.md).
export const trackingTool = {
  method: 'add_order_tracking',
  description: 'Add carrier tracking to a captured PayPal order, so the payment has proof of shipment.',
  parameters: z.object({
    order_id: z.string().regex(/^[A-Z0-9]{10,30}$/), capture_id: z.string().regex(/^[A-Z0-9]{10,30}$/),
    tracking_number: z.string().regex(/^[A-Za-z0-9]{6,40}$/), carrier: z.enum(['USPS', 'UPS', 'FEDEX', 'DHL']),
  }),
  async run(ctx: Ctx, a: any) {
    const r = await paypal(ctx, 'POST', `/v2/checkout/orders/${a.order_id}/track`, { json: { capture_id: a.capture_id, tracking_number: a.tracking_number, carrier: a.carrier, notify_payer: false } });
    return JSON.stringify(r.status < 300 ? { ok: true, status: r.status } : { error: { message: `PayPal ${r.status}`, details: r.body } });
  },
};

export function makeWatch(ctx: Ctx, shipWithinDays: () => number, log: (id: string, trigger: string, step: string, detail: string) => void, client = claude()) {
  // Re-read the capture and its order from PayPal, then assess.
  async function refresh(captureId: string, trigger = 'check'): Promise<Watched> {
    const cap = await paypal(ctx, 'GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`);
    if (cap.status !== 200) throw Object.assign(new Error(`PayPal ${cap.status} loading capture ${captureId}`), { code: cap.status === 404 ? 404 : 500 });
    const up = cap.body.links?.find((l: any) => l.rel === 'up')?.href as string | undefined;
    const order = up ? (await paypal(ctx, 'GET', new URL(up).pathname)).body : {};
    const pu = order.purchase_units?.[0] ?? {};
    const addr = pu.shipping?.address;
    const base = {
      capture_id: captureId, order_id: order.id ?? '', amount: Number(cap.body.amount?.value), currency: cap.body.amount?.currency_code ?? 'USD',
      captured_at: cap.body.create_time, item: pu.items?.[0]?.name ?? null,
      ship_to: addr ? [addr.address_line_1, addr.admin_area_2, addr.admin_area_1, addr.postal_code].filter(Boolean).join(', ') : null,
      ship_postal: addr?.postal_code ?? null, payer_postal: order.payer?.address?.postal_code ?? null,
      protection: cap.body.seller_protection?.status ?? null,
      trackers: (pu.shipping?.trackers ?? []).map((t: any) => ({ number: String(t.id).split('-').slice(1).join('-'), status: t.status })),
    };
    const prev = readOrders()[captureId];
    const a = assess(base, shipWithinDays());
    const key = a.flags.map((f) => f.code).join(',');
    const reason = !a.flags.length ? null : prev?.reason_key === key ? prev.reason : await explain(base, a.flags).catch(() => a.flags[0].text);
    const next = save({ ...base, ...a, reason, reason_key: key, checked_at: new Date().toISOString() });
    const what = `${next.currency} ${next.amount}${next.item ? ` (${next.item})` : ''}`;
    if (!prev) log(next.order_id || captureId, trigger, next.status === 'protected' ? 'order protected' : next.status === 'at_risk' ? 'order at risk' : 'watching order',
      next.status === 'protected' ? `${what}: tracking ${next.trackers.at(-1)?.number} is on PayPal`
      : next.status === 'at_risk' ? `${what}: ${next.reason}`
      : `${what}: add tracking within ${shipWithinDays()} day${shipWithinDays() === 1 ? '' : 's'} (your policy) so it has proof of shipment`);
    else if (prev.status !== next.status) log(next.order_id || captureId, trigger, next.status === 'protected' ? 'order protected' : next.status === 'at_risk' ? 'order at risk' : 'watching order', next.reason ?? (next.status === 'protected' ? `Tracking ${next.trackers.at(-1)?.number} is on PayPal` : 'Waiting for tracking'));
    return next;
  }

  // One plain sentence for the owner. The flags are already decided; the model only words them from these facts.
  async function explain(o: any, flags: Flag[]) {
    const res = await client.messages.create({
      model: 'claude-opus-5-5', max_tokens: 200,
      system: 'Write one short sentence (under 25 words) telling a small online seller what to do about this order now. Use only the facts and flags given. No greeting, no em dashes.',
      messages: [{ role: 'user', content: `Order: ${o.currency} ${o.amount}${o.item ? `, ${o.item}` : ''}, paid ${o.captured_at}, ship to ${o.ship_to ?? 'unknown'}.\nFlags:\n${flags.map((f) => `- ${f.text}`).join('\n')}` }],
    });
    const text = res.content.find((b: any) => b.type === 'text') as any;
    return (text?.text ?? flags[0].text).trim();
  }

  const open = () => Object.values(readOrders()).filter((o) => o.status !== 'protected').map((o) => o.capture_id);
  async function refreshAll() { for (const id of open()) await refresh(id, 'check').catch((e) => console.error('[watch]', id, e.message)); }
  return { refresh, refreshAll };
}
