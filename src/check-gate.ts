// Gate check: policy decisions offline, then held/approved/rejected calls through the real MCP server.
// Uses PBO (under PayPal review: only supporting info is open since its accept ran on Oct 10). The only approval here is
// an offer PayPal doesn't allow on PBO, so it is refused as stale. Check a case's links before approving anything on it.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decide, loadPolicy, readHolds, staleReason, type Hold } from './gate.js';
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
await assert.rejects(holds.approve(offerHold), /no longer allows make_offer/);
assert.equal(readHolds().find((h) => h.id === offerHold)?.status, 'stale');
console.log('owner approves $40 offer on a case PayPal closed to offers -> not run, hold marked stale');

assert.equal((await holds.reject(acceptHold)).status, 'rejected');
await assert.rejects(holds.approve(acceptHold), /already rejected/);
console.log('owner rejects concede -> cannot be approved afterwards');

await client.close();
console.log('ok');
