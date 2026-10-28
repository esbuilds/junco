// The demo's refund on /mcp (the Agent Toolkit over REST; PayPal's hosted calls fail, Oct 28), offline. A stand-in PayPal:
// the toolkit's REST runner and fetch (the capture re-read) are replaced, so every PayPal call is counted and none leaves.
// create_refund is held, never runs before approval, and runs once on approval; the same call again is refused; a second
// refund on the payment is refused once one ran, as is one held before the payment changed or before PayPal reported a
// refund. Temp directory: the repo's .junco is never read or written.
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

delete process.env.DATABASE_URL;
const dir = mkdtempSync(join(tmpdir(), 'junco-refund-'));
copyFileSync('policy.json', join(dir, 'policy.json'));
process.chdir(dir); mkdirSync('.junco');

const CAP = 'CAPTUREFIXTURE001'; // the toolkit's capture id format: 15 to 32 of [A-Za-z0-9_-]
let capture = { id: CAP, status: 'COMPLETED', update_time: '2026-10-29T10:00:00Z' };
const reads: string[] = [], refunds: any[] = [];
globalThis.fetch = (async (url: any) => {
  const u = String(url);
  if (!u.includes(`/v2/payments/captures/${CAP}`)) throw new Error(`check-refund-mcp: unexpected request ${u}`);
  reads.push(u);
  return new Response(JSON.stringify(capture), { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

const { createServer } = await import('./server.js');
const { flagHolds, loadPolicy, readHolds } = await import('./gate.js');
const policy = loadPolicy();
assert.deepEqual(['create_refund', 'get_refund', 'get_order'].map((t) => policy.tools[t]), ['hold', 'read', 'read']);
const { server, holds } = await createServer({ accessToken: 'offline', baseUrl: 'https://paypal.offline', token: async () => 'offline' } as any, policy);
for (const t of ['create_refund', 'get_refund', 'get_order']) assert.ok((server as any)._registeredTools[t], `/mcp lacks ${t}`);
// The toolkit resolves this._paypal.run at call time: the one place its REST calls start.
(server as any)._paypal.run = async (method: string, arg: any) => { refunds.push({ method, arg }); return JSON.stringify({ id: `RF${refunds.length}`, status: 'COMPLETED' }); };
console.log('toolkit: create_refund, get_refund and get_order on /mcp, classed hold, read, read');

const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'check-refund-mcp', version: '0' });
await client.connect(b);
const call = async (args: any) => JSON.parse(((await client.callTool({ name: 'create_refund', arguments: args })) as any).content[0].text);
const five = { capture_id: CAP, amount: { value: '5.00', currency_code: 'USD' } };

const first = await call(five);
assert.equal(first.held, true); assert.equal(refunds.length, 0);
assert.deepEqual(readHolds().find((h) => h.id === first.hold_id)?.case, { capture_id: CAP, status: 'COMPLETED', update_time: capture.update_time }); // payment snapshot
const again = await call(five);
assert.deepEqual([again.held, again.duplicate, again.hold_id], [true, true, first.hold_id]); assert.equal(readHolds().length, 1);
console.log('held: no PayPal refund before approval; the same call again makes no second hold');

const other = await call({ ...five, amount: { value: '7.00', currency_code: 'USD' } }); // a second refund, held before the first ran
const ran = await holds.approve(first.hold_id);
assert.equal(ran.status, 'completed'); assert.deepEqual(refunds, [{ method: 'create_refund', arg: five }]);
assert.equal(JSON.parse(ran.result!).id, 'RF1'); // PayPal's refund id, where the desk and the incident read it
const after = await call(five);
assert.equal(after.error?.type, 'duplicate_call'); assert.equal(refunds.length, 1);
await assert.rejects(holds.approve(other.hold_id), /another refund on payment CAPTUREFIXTURE001 ran after this was held/);
assert.equal(readHolds().find((h) => h.id === other.hold_id)?.status, 'stale'); assert.equal(refunds.length, 1);
console.log('approve: runs once through the toolkit; the same call after is refused; a second refund held before it is refused');

await new Promise((r) => setTimeout(r, 5)); // held after the refund ran, so only the payment re-read can refuse what follows
const changed = await call({ ...five, amount: { value: '2.00', currency_code: 'USD' } });
capture = { ...capture, update_time: '2026-10-29T11:00:00Z' }; // the payment moved after this was held
await assert.rejects(holds.approve(changed.hold_id), /changed since this was held/);
const reported = await call({ ...five, amount: { value: '3.00', currency_code: 'USD' } });
flagHolds({ capture_id: CAP }, 'PAYMENT.CAPTURE.REFUNDED', new Date(Date.now() + 1000).toISOString(), { id: 'RFWEBHOOK', at: new Date(Date.now() + 1000).toISOString() });
await assert.rejects(holds.approve(reported.hold_id), /PayPal reported refund RFWEBHOOK/);
assert.equal(refunds.length, 1); assert.ok(reads.length >= 4); // every hold and approval re-read the payment
await client.close();
console.log('re-check: a payment changed since the hold, or a refund PayPal reported, refuses the approval; nothing sent');
// The tie that let a second refund run (Oct 28): a hold made in the same millisecond another refund started running.
const { refundRanSince } = await import('../packages/junco-gate/src/paypal.js');
const T = '2026-10-29T12:00:00.000Z', base = { method: 'create_refund', args: five, reason: 'r', status: 'pending' as const };
assert.equal(refundRanSince({ ...base, id: 'h2', created: T }, [{ ...base, id: 'h1', created: '2026-10-29T11:59:00.000Z', status: 'completed', ran: T }])?.id, 'h1');
assert.equal(refundRanSince({ ...base, id: 'h2', created: T }, [{ ...base, id: 'h1', created: '2026-10-29T11:58:00.000Z', status: 'completed', ran: '2026-10-29T11:59:59.999Z' }]), undefined); // ran before: the owner saw it
console.log('tie: a refund that started running in the same millisecond a hold was made counts as after it');
console.log(`refund-mcp: ok (1 refund through the toolkit, ${reads.length} capture re-reads, all stand-ins)`);
