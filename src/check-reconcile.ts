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

// Shapes as PayPal returned them on Oct 30: 5AY and 7CL are PayPal's dispute holds, 88P is the spike's real outside refund.
const real = (cap: string, status: string, reason: string | null, id: string, rstatus: string, v: string, refunded: string | null) => async (p: string) => (p.includes('captures')
  ? { status: 200, body: { status, ...(reason && { status_details: { reason } }), links: [{ rel: 'up', href: `${API}/v2/checkout/orders/O${cap}` }] } }
  : { status: 200, body: { purchase_units: [{ payments: { refunds: [{ id, amount: amt(v), status: rstatus, ...(refunded && { seller_payable_breakdown: { total_refunded_amount: amt(refunded) } }), links: [{ rel: 'up', href: `${API}/v2/payments/captures/${cap}` }] }] } }] } });
const held = async (cap: string, id: string, v: string, hs: Hold[] = []) => reconcile(cap, hs, real(cap, 'PENDING', 'BUYER_COMPLAINT', id, 'PENDING', v, '0.00'));
const noRecord = (l: Awaited<ReturnType<typeof reconcile>>) => l.filter((e) => e.summary.includes('no record of'));

const a5 = await held('16J87332GU845950P', '6E9082945T161501K', '59.35');
assert.equal(a5[0].summary, 'PayPal shows no refunds on this payment apart from a dispute hold, and lists the payment as PENDING: BUYER_COMPLAINT. The desk ran none, so the two agree.');
assert.equal(a5[1].summary, "PayPal's record reads as a dispute hold of 59.35 USD: entry 6E9082945T161501K is PENDING on a payment held for a buyer complaint, and PayPal records 0.00 USD refunded, so no money has gone back to the buyer. The desk has nothing to match here.");
assert.equal(a5[1].source, 'PayPal'); assert.equal(a5[1].ref?.refund_id, '6E9082945T161501K'); assert.equal(a5.length, 2);
assert.equal(noRecord(a5).length, 0, 'a dispute hold reads as a refund the desk has no record of');
const a7 = await held('1PC92963XA1655418', '9D802017TJ131302P', '36.18', [{ ...hold('853278a7', 'rejected', '10.00'), args: { capture_id: '1PC92963XA1655418', amount: amt('10.00') } }]);
assert.ok(a7[1].summary.startsWith("PayPal's record reads as a dispute hold of 36.18 USD: entry 9D802017TJ131302P")); assert.equal(noRecord(a7).length, 0);
console.log('dispute hold: 5AY and 7CL say so with the amount, no money gone back, no mismatch');

const a8 = await reconcile('88P92146U3288611K', [], real('88P92146U3288611K', 'PARTIALLY_REFUNDED', null, '2V173278FH578534S', 'COMPLETED', '1.37', '1.37'));
assert.equal(a8[0].summary, 'PayPal shows 1 refund on this payment, and lists the payment as PARTIALLY_REFUNDED.');
assert.equal(a8[1].summary, 'PayPal shows a refund of 1.37 USD (2V173278FH578534S, COMPLETED) that the desk has no record of.');
// Money PayPal says went back stays a mismatch on a disputed payment, and so does a line with no refunded figure to go on.
const paid = await reconcile('CAPPAID', [], real('CAPPAID', 'PENDING', 'BUYER_COMPLAINT', 'RFPAID', 'PENDING', '4.00', '4.00'));
const bare = await reconcile('CAPBARE', [], real('CAPBARE', 'PENDING', 'BUYER_COMPLAINT', 'RFBARE', 'PENDING', '4.00', null));
const other = await reconcile('CAPELSE', [], real('CAPELSE', 'PENDING', 'ECHECK', 'RFELSE', 'PENDING', '4.00', '0.00'));
for (const l of [paid, bare, other]) assert.equal(noRecord(l).length, 1, `${l[1].summary}`);
console.log('outside refund: 88P and near misses of a dispute hold still say the desk has no record of them');

// HHC on Oct 31, after an owner-approved accept: PayPal lists its dispute hold as FAILED beside the refund it paid.
const accept = { id: 'ef2a0fcc', method: 'accept_dispute_claim', args: { dispute_id: 'PP-R-HHC-10191540', note: 'x' }, reason: 'r', created: '', status: 'completed' } as Hold;
const both = (cap: string) => async (p: string) => (p.includes('captures')
  ? { status: 200, body: { status: 'REFUNDED', links: [{ rel: 'up', href: `${API}/v2/checkout/orders/O${cap}` }] } }
  : { status: 200, body: { purchase_units: [{ payments: { refunds: [['4PC09475GD247335P', 'FAILED', '59.35'], ['2WA839249R304813M', 'COMPLETED', '62.00']].map(([id, status, v]) => ({ id, status, amount: amt(v), links: [{ rel: 'up', href: `${API}/v2/payments/captures/${cap}` }] })) } }] } });
const hhc = await reconcile('6DK52507E0337070T', [accept], both('6DK52507E0337070T'));
assert.equal(hhc[0].summary, 'PayPal shows 1 refund on this payment apart from a dispute hold, and lists the payment as REFUNDED.');
assert.equal(hhc[1].summary, "PayPal's dispute hold of 59.35 USD ended when the dispute settled: entry 4PC09475GD247335P is FAILED, and no money went back on it.");
assert.equal(hhc[1].match, 'dispute_hold');
assert.equal(hhc[2].summary, "PayPal shows refund 2WA839249R304813M for 62.00 USD (COMPLETED). The desk didn't send it as a refund: it ran accept dispute claim (hold ef2a0fcc) on this payment's dispute, and PayPal pays a settled dispute back as a refund of its own.");
assert.equal(hhc[2].match, 'settled'); assert.equal(noRecord(hhc).length, 0);
const unsettled = await reconcile('CAPFAIL', [], both('CAPFAIL')); // no settled dispute: a FAILED entry is still one the desk can't explain
assert.equal(noRecord(unsettled).length, 2);
console.log('settled dispute: the ended hold is no refund, the refund is the settlement, nothing reads as unknown');
