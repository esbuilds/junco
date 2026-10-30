// RECONCILIATION, offline: fixture PayPal capture and order JSON against fixture holds. A matched refund, one at PayPal
// only, one on the desk only, and PayPal not answering each give the right line; a second read inside a minute is cached.
import assert from 'node:assert/strict';
import { reconcile, type PayPalGet } from './reconcile.js';
import type { Hold } from './gate.js';

globalThis.fetch = (async () => { throw new Error('check-reconcile: no network'); }) as any;
const API = 'https://api.sandbox.paypal.com', CAP = 'CAPREC1', amt = (v: string) => ({ value: v, currency_code: 'USD' });
const refund = (id: string, v: string, cap = CAP) => ({ id, amount: amt(v), status: 'COMPLETED', links: [{ rel: 'up', href: `${API}/v2/payments/captures/${cap}` }] });
const PAYPAL: Record<string, any> = {
  [`/v2/payments/captures/${CAP}`]: { status: 'PARTIALLY_REFUNDED', links: [{ rel: 'refund', href: `${API}/v2/payments/captures/${CAP}/refund` }, { rel: 'up', href: `${API}/v2/checkout/orders/ORDREC1` }] },
  '/v2/checkout/orders/ORDREC1': { purchase_units: [{ payments: { refunds: [refund('RFMATCH', '20.00'), refund('RFSTRAY', '12.00'), refund('RFOTHER', '5.00', 'CAPOTHER')] } }] },
};
let calls = 0;
const get: PayPalGet = async (p) => { calls++; return PAYPAL[p] ? { status: 200, body: PAYPAL[p] } : { status: 404, body: {} }; };
const hold = (id: string, status: string, v: string, result?: object): Hold =>
  ({ id, method: 'create_refund', args: { capture_id: CAP, amount: amt(v) }, reason: 'policy: create_refund = hold', created: '2026-10-29T10:00:00.000Z', status, ...(result && { result: JSON.stringify(result) }) } as Hold);
const holds = [hold('h3f2a', 'completed', '20.00', { id: 'RFMATCH', status: 'COMPLETED' }), hold('hgone', 'completed', '8.00', { id: 'RFGONE', status: 'COMPLETED' }),
  hold('hno', 'rejected', '12.00')];

const lines = await reconcile(CAP, holds, get);
const say = (id: string) => lines.find((e) => e.id === `reconciliation:${id}`)!;
assert.equal(say('read').summary, 'PayPal shows 2 refunds on this payment, and lists the payment as PARTIALLY_REFUNDED.'); // RFOTHER is another capture's
assert.equal(say('RFMATCH').summary, 'PayPal shows refund RFMATCH for 20.00 USD (COMPLETED). The desk made it: hold h3f2a, approved by the owner.');
assert.equal(say('RFMATCH').source, 'PayPal + holds');
assert.equal(say('RFSTRAY').summary, 'PayPal shows a refund of 12.00 USD (RFSTRAY, COMPLETED) that the desk has no record of. Hold hno asked for the same amount, but it was rejected and never sent.');
assert.equal(say('RFSTRAY').source, 'PayPal');
assert.equal(say('hgone').summary, "The desk says hold hgone ran a refund of 8.00 USD (PayPal refund RFGONE), but PayPal doesn't show it on this payment.");
assert.equal(say('hgone').source, 'holds');
assert.equal(lines.length, 4); assert.ok(lines.every((e) => e.kind === 'reconciliation' && e.mode === 'live' && e.ref?.capture_id === CAP));
console.log('lines: matched, at PayPal only and on the desk only, each from its own record');

const before = calls; await reconcile(CAP, holds, get);
assert.equal(calls, before, 'a second read inside a minute reached PayPal');
console.log('cache: a second read inside a minute makes no PayPal call');

const down = await reconcile('CAPDOWN', [], async () => { throw new Error('socket hang up'); });
assert.deepEqual(down.map((e) => [e.summary, e.mode]), [["PayPal didn't answer (socket hang up), so the refunds on this payment were not checked against the desk.", 'recorded']]);
const none = await reconcile('CAPNONE', [], async (p) => (p.includes('captures') ? { status: 200, body: { status: 'COMPLETED', links: [{ rel: 'up', href: `${API}/v2/checkout/orders/O` }] } } : { status: 200, body: { purchase_units: [{}] } }));
assert.equal(none[0].summary, 'PayPal shows no refunds on this payment, and lists the payment as COMPLETED. The desk ran none, so the two agree.');
console.log("failure: PayPal not answering is one line, not an error; no refunds on either side agree");
