// OUTSIDE REFUND, offline: PayPal's PAYMENT.CAPTURE.REFUNDED against fixture records, with a stand-in PayPal GET and ping.
// Only a refund reconciliation calls at PayPal only pings, once. The desk's own, a settled dispute's, a dispute hold and a
// refund on a purchase the desk doesn't know don't. A hold still running is waited for, and a cached read can't hide it.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIncident, reconciled } from './incident.js';
import { outsideRefund, readOutside } from './outside-refund.js';
import type { PayPalGet } from './reconcile.js';

const DESK = readFileSync('src/desk.ts', 'utf8');
assert.ok(DESK.indexOf('flagHolds({ capture_id: capture }') < DESK.indexOf('outsideRefund(event.resource'), 'the alert runs after the hold flagging');

globalThis.fetch = (async () => { throw new Error('check-outside-refund: no network'); }) as any;
delete process.env.DATABASE_URL; // no Postgres mirror from a fixture run
const dir = mkdtempSync(join(tmpdir(), 'junco-outside-'));
copyFileSync('policy.json', join(dir, 'policy.json'));
process.chdir(dir);
mkdirSync('.junco');
const put = (f: string, v: unknown) => writeFileSync(`.junco/${f}`, JSON.stringify(v));

const API = 'https://api.sandbox.paypal.com', amt = (v: string) => ({ value: v, currency_code: 'USD' });
const CAPS = ['OUT', 'DESK', 'RACEDESK', 'RACEOUT', 'STUCK', 'SETTLED', 'HELD', 'ALLOWED', 'ALLOWEDOTHER', 'DOWN', 'STALE'].map((c) => `CAP${c}`);
const purchase = (cap: string) => ({ buyer_txn: `TXN${cap}`.padEnd(17, 'X'), amount: '38.00', order_id: `ORD${cap}`, tracking: false, added: '2026-10-30T10:00:00.000Z',
  agent: { instruction: `bag ${cap}`, budget: '45', sku: 'WKD-03', listing: 'WKD-03 listing', reason: 'fits', agent: 'Check shopper', capture_id: cap, paid_at: '2026-10-30T09:56:00.000Z' } });
put('pool.json', CAPS.map(purchase));
put('store-runs.json', [{ at: '2026-10-30T10:00:00.000Z', visitor: 'v1', buyer_txn: purchase('CAPSETTLED').buyer_txn, kind: 'agent', dispute_id: 'PP-D-SETTLED' }]);
const hold = (id: string, cap: string, status: string, result?: unknown) => ({ id, method: 'create_refund', args: { capture_id: cap, amount: amt('5.00') }, reason: 'policy: create_refund = hold',
  created: '2026-10-30T10:00:00.000Z', status, ran: '2026-10-30T10:01:00.000Z', ...(result !== undefined && { result: JSON.stringify(result) }) });
const body = { id: 'RFDESK', status: 'COMPLETED' };
const holds = [hold('hdesk', 'CAPDESK', 'completed', { content: [{ type: 'text', text: JSON.stringify(body) }] }), // the hosted wrapper's shape
  hold('hrace', 'CAPRACEDESK', 'executing'), hold('hraceout', 'CAPRACEOUT', 'executing'), hold('hstuck', 'CAPSTUCK', 'unknown', { error: { type: 'outcome_unknown', message: 'socket hang up' } }),
  { id: 'hsettle', method: 'accept_dispute_claim', args: { dispute_id: 'PP-D-SETTLED' }, reason: 'policy: accept_dispute_claim = hold', created: '2026-10-30T10:00:00.000Z', status: 'completed', ran: '2026-10-30T10:01:00.000Z', result: '{"links":[]}' }];
put('holds.json', holds);
const allowed = (cap: string, v: string) => ({ at: '2026-10-30T10:02:00.000Z', method: 'create_refund', args: { capture_id: cap, amount: amt(v) }, verdict: 'allow', reason: 'within the limit', source: 'desk agent' });
put('gate-log.json', [allowed('CAPALLOWED', '5.00'), allowed('CAPALLOWEDOTHER', '7.00')]);

// PayPal's shapes as it sent them on Oct 30 (the event for refund 2V173278FH578534S).
const entry = (id: string, cap: string, v: string, status = 'COMPLETED', refunded = v) => ({ id, amount: amt(v), status, seller_payable_breakdown: { total_refunded_amount: amt(refunded) },
  create_time: '2026-10-30T05:47:05-07:00', links: [{ href: `${API}/v2/payments/refunds/${id}`, rel: 'self' }, { href: `${API}/v2/payments/captures/${cap}`, rel: 'up' }] });
const PAYPAL: Record<string, { status: string; reason?: string; refunds: any[] }> = {};
let reads = 0;
const get: PayPalGet = async (p) => {
  reads++;
  const cap = p.split('/').pop()!.replace(/^ORD/, ''), o = PAYPAL[cap];
  if (!o) return { status: 404, body: {} };
  return p.includes('captures') ? { status: 200, body: { status: o.status, ...(o.reason && { status_details: { reason: o.reason } }), links: [{ rel: 'up', href: `${API}/v2/checkout/orders/ORD${cap}` }] } }
    : { status: 200, body: { purchase_units: [{ payments: { refunds: o.refunds } }] } };
};
let pings: string[] = [];
const run = (r: any, cap: string, wait: () => Promise<void> = async () => {}, g = get) => outsideRefund(r, cap, { get: g, notify: (t) => pings.push(t), desk: 'https://desk.test', wait });
const refund = (cap: string, id: string, v = '5.00', status?: string, refunded?: string) => { const e = entry(id, cap, v, status, refunded); PAYPAL[cap] ??= { status: 'PARTIALLY_REFUNDED', refunds: [] }; PAYPAL[cap].refunds.push(e); return e; };

const out = refund('CAPOUT', 'RFOUT', '1.37');
await run(out, 'CAPOUT');
assert.deepEqual(pings, [`PayPal reported a refund of 1.37 USD (RFOUT) the desk didn't make.\n<https://desk.test/incident/${purchase('CAPOUT').buyer_txn}|Open the incident>`]);
const inc = await reconciled(buildIncident('CAPOUT'), get);
const ev = inc!.events.find((e) => e.kind === 'outside_refund')!;
assert.deepEqual({ id: ev.id, at: ev.at, mode: ev.mode, source: ev.source, ref: ev.ref }, { id: 'outside_refund:RFOUT', at: '2026-10-30T12:47:05.000Z', mode: 'live', source: 'webhook', ref: { capture_id: 'CAPOUT', refund_id: 'RFOUT' } });
assert.equal(ev.summary, "PayPal reported a refund of 1.37 USD (RFOUT) the desk didn't make.");
assert.equal(ev.actor, 'PayPal');
assert.equal(inc!.events.find((e) => e.id === 'reconciliation:RFOUT')?.match, 'paypal_only');
assert.equal(JSON.parse(readFileSync('.junco/outside-refunds.json', 'utf8')).length, 1);
console.log('outside: one event, LIVE from the webhook, one ping with the incident link, kept in .junco');

pings = [];
await run(out, 'CAPOUT'); // PayPal delivers an event more than once
assert.equal(pings.length, 0);
const twin = refund('CAPSTALE', 'RFTWIN', '2.00');
await Promise.all([run(twin, 'CAPSTALE'), run(twin, 'CAPSTALE')]);
assert.equal(pings.length, 1);
console.log('dedupe: a repeated event pings once, also when two arrive together');

pings = [];
PAYPAL.CAPDESK = { status: 'PARTIALLY_REFUNDED', refunds: [] };
await run(refund('CAPDESK', 'RFDESK'), 'CAPDESK');
assert.deepEqual(pings, []);
const inFlight = (cap: string, id: string, status: string, result: unknown) => async () => {
  const hs = JSON.parse(readFileSync('.junco/holds.json', 'utf8')); const h = hs.find((x: any) => x.args?.capture_id === cap);
  Object.assign(h, { status, result: JSON.stringify(result) }); put('holds.json', hs); void id;
};
let waits = 0;
await run(refund('CAPRACEDESK', 'RFRACE'), 'CAPRACEDESK', async () => { if (++waits === 2) await inFlight('CAPRACEDESK', 'RFRACE', 'completed', { id: 'RFRACE', status: 'COMPLETED' })(); });
assert.deepEqual(pings, []);
assert.ok(waits >= 2);
console.log("desk's own: no ping, in the hosted wrapper's shape and when the hold's result lands after the webhook");

await run(refund('CAPRACEOUT', 'RFRACEOUT'), 'CAPRACEOUT', inFlight('CAPRACEOUT', 'RFRACEOUT', 'failed', { error: { message: 'refused' } }));
assert.equal(pings.length, 1, 'a hold that failed did not make this refund');
pings = [];
await run(refund('CAPSTUCK', 'RFSTUCK'), 'CAPSTUCK');
assert.deepEqual(pings, []);
assert.ok(!readOutside().some((x) => x.refund_id === 'RFSTUCK'), 'a hold of unknown outcome might be this refund');
console.log("in flight: a failed hold doesn't excuse the refund; one of unknown outcome means no claim either way");

await run(refund('CAPSETTLED', 'RFSETTLED'), 'CAPSETTLED');
PAYPAL.CAPHELD = { status: 'PENDING', reason: 'BUYER_COMPLAINT', refunds: [] };
await run(refund('CAPHELD', 'RFHELD', '36.18', 'PENDING', '0.00'), 'CAPHELD');
await run(refund('CAPALLOWED', 'RFALLOWED'), 'CAPALLOWED');
assert.deepEqual(pings, []);
await run(refund('CAPALLOWEDOTHER', 'RFOTHER'), 'CAPALLOWEDOTHER');
assert.equal(pings.length, 1, 'an allowed refund of another amount is not this one');
pings = [];
console.log('not outside: a settled dispute, a dispute hold, and a refund the gate allowed through');

const before = reads;
await run(entry('RFUNKNOWN', 'CAPNOBODY', '3.00'), 'CAPNOBODY');
assert.deepEqual(pings, []);
assert.equal(reads, before, 'a purchase the desk doesn\'t know needs no PayPal read');
assert.equal(readOutside().find((x) => x.refund_id === 'RFUNKNOWN')?.incident_id, null);
console.log("unknown purchase: logged, kept, no ping");

await run(refund('CAPDOWN', 'RFDOWN'), 'CAPDOWN', async () => {}, async () => { throw new Error('socket hang up'); });
assert.deepEqual(pings, []);
assert.ok(!readOutside().some((x) => x.refund_id === 'RFDOWN'));
console.log("paypal down: it can't be checked, so no claim and nothing kept");

PAYPAL.CAPSTALE.refunds = [];
await reconciled(buildIncident('CAPSTALE'), get); // reads and caches a payment with no refunds on it
await run(refund('CAPSTALE', 'RFLATER', '4.00'), 'CAPSTALE');
assert.equal(pings.length, 1, 'a cached read hid the refund PayPal just reported');
assert.ok((await reconciled(buildIncident('CAPSTALE'), get))!.events.some((e) => e.id === 'reconciliation:RFLATER'));
console.log('cache: the webhook drops the cached read, so the page shows the refund at once too');
