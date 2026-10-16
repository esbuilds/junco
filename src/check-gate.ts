// Gate check: policy decisions offline, then held/approved/rejected calls through the real MCP server.
// Uses PBO (under PayPal review: only supporting info is open since its accept ran on Oct 10). The only approval here is
// an offer PayPal doesn't allow on PBO, so it is refused as stale. Check a case's links before approving anything on it.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decide, gate, landed, loadPolicy, readHolds, staleReason, type Hold } from './gate.js';
import { createServer, sandboxCtx } from './server.js';

const policy = loadPolicy();
const offer = (v: string) => ({ dispute_id: 'PP-R-PBO-10190474', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: v }, note: 'Partial refund to settle' });
assert.equal(decide(policy, 'make_dispute_offer', offer('25')).verdict, 'allow');
assert.equal(decide(policy, 'make_dispute_offer', offer('25.01')).verdict, 'hold');
assert.equal(decide(policy, 'make_dispute_offer', { dispute_id: 'x' }).verdict, 'hold');
assert.equal(decide(policy, 'accept_dispute_claim', {}).verdict, 'hold');
assert.equal(decide(policy, 'some_new_tool', {}).verdict, 'deny'); // T1: unclassified tools are denied
assert.equal(decide(policy, 'get_dispute', {}).verdict, 'allow'); // read
assert.equal(decide(policy, 'pay_order', {}).verdict, 'deny'); // not exposed
assert.equal(decide({ default: 'hold', tools: { create_refund: 'deny' } }, 'create_refund', {}).verdict, 'deny');
console.log('policy: limit edge, missing amount, unclassified denied, read, not exposed, deny all decided correctly');

// Standing approval: one dispute, capped at `limit`; accept counts as the full disputed amount.
const budgets = { 'PP-R-PBO-10190474': { limit: 40, amount: 48, currency: 'USD', set_at: '' } };
assert.equal(decide(policy, 'make_dispute_offer', offer('40'), budgets).verdict, 'allow');
assert.equal(decide(policy, 'make_dispute_offer', offer('40.01'), budgets).verdict, 'hold');
assert.equal(decide(policy, 'accept_dispute_claim', { dispute_id: 'PP-R-PBO-10190474' }, budgets).verdict, 'hold'); // 48 > 40
assert.equal(decide(policy, 'accept_dispute_claim', { dispute_id: 'PP-R-PBO-10190474' }, { 'PP-R-PBO-10190474': { ...budgets['PP-R-PBO-10190474'], limit: 48 } }).verdict, 'allow');
assert.equal(decide(policy, 'accept_dispute_claim', { dispute_id: 'PP-R-OTHER' }, budgets).verdict, 'hold'); // other disputes untouched
console.log('standing approval: cap edge, full-amount accept, scoped to one dispute');

// Approval binds to the case the owner saw: a moved, resized, resolved or no-longer-allowed case is not run.
const held: Hold = { id: 'h', method: 'accept_dispute_claim', args: {}, reason: '', created: '', status: 'pending', case: { stage: 'INQUIRY', amount: '48.00 USD' } };
const kase = (o: any = {}) => ({ status: 'WAITING_FOR_SELLER_RESPONSE', dispute_life_cycle_stage: 'INQUIRY', dispute_amount: { value: '48.00', currency_code: 'USD' }, links: [{ rel: 'accept_claim' }], ...o });
assert.equal(staleReason(held, kase()), null);
assert.match(staleReason(held, kase({ dispute_life_cycle_stage: 'CHARGEBACK' }))!, /moved from INQUIRY to CHARGEBACK/);
assert.match(staleReason(held, kase({ dispute_amount: { value: '60.00', currency_code: 'USD' } }))!, /amount changed/);
assert.match(staleReason(held, kase({ status: 'RESOLVED' }))!, /already resolved/);
assert.match(staleReason(held, kase({ links: [] }))!, /no longer allows accept_claim/);
console.log('stale approvals: stage, amount, resolved, PayPal links all refuse to run');

// T2: did an unknown-outcome write land? Compared against what was on the case before it ran.
const before = { status: 'WAITING_FOR_SELLER_RESPONSE', messages: 1, evidences: 0, info: 0, offers: 0, rels: ['accept_claim', 'send_message'] };
assert.equal(landed('send_dispute_message', before, kase({ messages: [{}, {}] })), true);
assert.equal(landed('send_dispute_message', before, kase({ messages: [{}] })), false);
assert.equal(landed('accept_dispute_claim', before, kase({ status: 'RESOLVED' })), true);
assert.equal(landed('accept_dispute_claim', before, kase()), false);
assert.equal(landed('provide_dispute_evidence', before, kase({ evidences: [{}] })), true);
assert.equal(landed('create_refund', before, kase()), null);

// Lifecycle through a fake tool: completed, failed (PayPal refused), unknown settled by re-read, never re-run.
const open = (o: any = {}) => kase({ links: [{ rel: 'send_message' }], ...o });
let calls = 0, reply: () => any = () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }), now = open();
const fake: any = { _registeredTools: { send_dispute_message: { handler: async () => { calls++; return reply(); }, update(u: any) { this.handler = u.callback; } } } };
const g = gate(fake, { default: 'deny', tools: { send_dispute_message: 'hold' } }, undefined, async () => now);
const run = Date.now(); let n = 0; // holds persist in .junco/holds.json, so args are unique per run; each ask is a different message: the same call twice is refused as a duplicate (checked below)
const ask = async () => JSON.parse((await fake._registeredTools.send_dispute_message.handler({ dispute_id: 'PP-T2', message: `m${run}-${++n}` }, {})).content[0].text).hold_id;
assert.equal((await g.approve(await ask())).status, 'completed');
reply = () => ({ content: [{ type: 'text', text: '{"error":{"type":"action_not_allowed"}}' }] });
assert.equal((await g.approve(await ask())).status, 'failed');
reply = () => { now = open({ messages: [{}] }); throw new Error('socket hang up'); }; // landed, then the connection dropped
assert.equal((await g.approve(await ask())).status, 'completed');
now = open(); reply = () => { throw new Error('socket hang up'); }; // dropped before landing
const lost = await ask();
assert.equal((await g.approve(lost)).status, 'failed');
assert.equal(calls, 4); await assert.rejects(g.approve(lost), /already failed/); assert.equal(calls, 4);
console.log('lifecycle: completed, refused -> failed, dropped call settled by re-read both ways, never re-run');

// The double refund: an agent asks for the same refund twice. The repeat joins the waiting hold; once it ran, a repeat is
// refused; a second refund worded differently gets its own hold, and approving it is refused because the payment changed.
let pay = { id: `CAP${run}`, status: 'COMPLETED', update_time: 't0' }, refunds = 0;
const rf: any = { _registeredTools: { create_refund: { handler: async () => { refunds++; pay = { ...pay, status: 'PARTIALLY_REFUNDED', update_time: 't1' }; return { content: [{ type: 'text', text: '{"id":"R1"}' }] }; }, update(u: any) { this.handler = u.callback; } } } };
const rg = gate(rf, { default: 'deny', tools: { create_refund: 'hold' } }, undefined, undefined, 'check-refund', undefined, async () => pay);
const refund = async (note: string) => JSON.parse((await rf._registeredTools.create_refund.handler({ capture_id: `CAP${run}`, amount: { value: '3.00', currency_code: 'USD' }, note_to_payer: note }, {})).content[0].text);
const first = await refund('Sorry'), again = await refund('Sorry'), reworded = await refund('Sorry again');
assert.equal(again.hold_id, first.hold_id); assert.equal(again.duplicate, true); assert.notEqual(reworded.hold_id, first.hold_id);
assert.equal((await rg.approve(first.hold_id)).status, 'completed');
assert.equal((await refund('Sorry')).error?.type, 'duplicate_call');
await assert.rejects(rg.approve(reworded.hold_id), /another refund on payment CAP\d+ ran after this was held/);
// PayPal's own record also refuses: a capture that changed (refunded outside this gate) since the hold.
const outside = await refund('Outside'); pay = { ...pay, status: 'REFUNDED', update_time: 't2' };
await assert.rejects(rg.approve(outside.hold_id), /already fully refunded/);
assert.equal(refunds, 1);
console.log('double refund: repeat joins the hold, repeat after it ran refused, reworded second refund refused on re-read; one refund sent');

const [a, b] = InMemoryTransport.createLinkedPair();
const { server, holds } = await createServer(await sandboxCtx(), policy);
await server.connect(a);
const client = new Client({ name: 'check-gate', version: '0' });
await client.connect(b);
const call = async (name: string, args: any) => JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);

let r = await call('make_dispute_offer', offer('10'));
assert.equal(r.error?.type, 'action_not_allowed'); console.log('$10 offer -> gate allowed, reached PayPal check:', r.error.message);

r = await call('make_dispute_offer', offer('40'));
assert.equal(r.held, true); const offerHold = r.hold_id; console.log('$40 offer -> held', offerHold, '|', r.reason);

r = await call('accept_dispute_claim', { dispute_id: 'PP-R-PBO-10190474', note: 'Lost' });
assert.equal(r.held, true); const acceptHold = r.hold_id; console.log('stock accept_dispute_claim -> held', acceptHold);

assert(readHolds().some((h) => h.id === offerHold && h.status === 'pending'));
await assert.rejects(holds.approve(offerHold), /Not run: (PayPal no longer allows make_offer|the case is already resolved)/);
assert.equal(readHolds().find((h) => h.id === offerHold)?.status, 'stale');
console.log('owner approves $40 offer on a case PayPal closed to offers (now resolved) -> not run, hold marked stale');

assert.equal((await holds.reject(acceptHold)).status, 'rejected');
await assert.rejects(holds.approve(acceptHold), /already rejected/);
console.log('owner rejects concede -> cannot be approved afterwards');

await client.close();
console.log('ok');
