// Gate check: policy decisions offline, then held/approved/rejected calls through the real MCP server.
// Uses PBO, where PayPal currently allows no merchant actions, so even approved calls cannot move sandbox money.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decide, loadPolicy, readHolds } from './gate.js';
import { createServer, sandboxCtx } from './server.js';

const policy = loadPolicy();
const offer = (v: string) => ({ dispute_id: 'PP-R-PBO-10190474', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: v }, note: 'Partial refund to settle' });
assert.equal(decide(policy, 'make_dispute_offer', offer('25')).verdict, 'allow');
assert.equal(decide(policy, 'make_dispute_offer', offer('25.01')).verdict, 'hold');
assert.equal(decide(policy, 'make_dispute_offer', { dispute_id: 'x' }).verdict, 'hold');
assert.equal(decide(policy, 'accept_dispute_claim', {}).verdict, 'hold');
assert.equal(decide(policy, 'some_new_tool', {}).verdict, 'hold');
assert.equal(decide({ default: 'hold', tools: { create_refund: 'deny' } }, 'create_refund', {}).verdict, 'deny');
console.log('policy: limit edge, missing amount, unknown tool, deny all decided correctly');

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
const approved = await holds.approve(offerHold);
assert.equal(approved.status, 'approved'); assert.match(approved.result ?? '', /action_not_allowed/);
console.log('owner approves $40 offer -> ran, PayPal check result:', JSON.parse(approved.result!).error.message);

assert.equal((await holds.reject(acceptHold)).status, 'rejected');
await assert.rejects(holds.approve(acceptHold), /already rejected/);
console.log('owner rejects concede -> cannot be approved afterwards');

await client.close();
console.log('ok');
