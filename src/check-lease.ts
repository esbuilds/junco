// D1 lease check, offline: who may write on a pool case, at the gate and on hold approvals. Runs in a temp directory.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'junco-lease-')));
delete process.env.DATABASE_URL; // nothing mirrored
const { actor, leaseRefusal, decideRefusal, LEASE_MS, RETIRE_MS, isWaiting, keepReady, lease, refusal, extraFor, readRuns } = await import('./store-dispute.js');
const { gate, guards } = await import('./gate.js');

mkdirSync('.junco');
const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();
writeFileSync('.junco/store-runs.json', JSON.stringify([
  // filed long ago, leased a minute ago: the lease counts from the lease, not the filing
  { at: iso(LEASE_MS * 3), leased_at: iso(60_000), visitor: 'ip', session: 'alice', buyer_txn: 'A', kind: 'unshipped', dispute_id: 'PP-LIVE' },
  { at: iso(LEASE_MS + 60_000), visitor: 'ip', session: 'alice', buyer_txn: 'B', dispute_id: 'PP-PAST' },
]));
const as = <T>(who: { owner: boolean; session: string } | null, f: () => T) => (who ? actor.run(who, f) : f());
const alice = { owner: false, session: 'alice' }, bob = { owner: false, session: 'bob' }, owner = { owner: true, session: 'x' };

assert.equal(as(alice, () => leaseRefusal('PP-LIVE')), null);
assert.match(as(bob, () => leaseRefusal('PP-LIVE'))!, /leased to another visitor/);
assert.match(as(alice, () => leaseRefusal('PP-PAST'))!, /past runs are read-only/);
assert.equal(as(owner, () => leaseRefusal('PP-PAST')), null);
assert.equal(as(null, () => leaseRefusal('PP-LIVE')), null); // webhooks and timers: the system
assert.equal(as(bob, () => leaseRefusal('PP-R-VQB')), null); // not a pool case
// v3.12 call 1: visitors approve or reject only on the case they hold; shared cases are the owner's.
assert.equal(as(alice, () => decideRefusal('PP-LIVE')), null);
assert.match(as(bob, () => decideRefusal('PP-R-VQB'))!, /only the owner/);
assert.match(as(bob, () => decideRefusal('PP-LIVE'))!, /leased to another visitor/);
assert.equal(as(owner, () => decideRefusal('PP-R-VQB')), null);
console.log('lease: holder, other visitor, ended run, owner, system, non-pool case; decide only on your own case');

// Through the gate: a held write by the holder; another visitor is refused before policy, and can't approve the hold.
let calls = 0;
const fake: any = { _registeredTools: { accept_dispute_claim: { handler: async () => { calls++; return { content: [{ type: 'text', text: '{}' }] }; }, update(u: any) { this.handler = u.callback; } } } };
const g = gate(fake, { default: 'deny', tools: { accept_dispute_claim: 'hold' } });
guards.length = 0; guards.push((_m, args, phase) => (phase === 'decide' ? decideRefusal : leaseRefusal)(args?.dispute_id));
const call = () => fake._registeredTools.accept_dispute_claim.handler({ dispute_id: 'PP-LIVE' }, {}).then((r: any) => JSON.parse(r.content[0].text));
assert.equal((await as(bob, call)).error?.type, 'denied_by_guard');
const held = await as(alice, call);
assert.equal(held.held, true);
await assert.rejects(as(bob, () => g.approve(held.hold_id)), /leased to another visitor/);
assert.equal((await as(alice, () => g.approve(held.hold_id))).status, 'completed');
assert.equal(calls, 1);
console.log('gate: other visitor denied, holder held then approved, other visitor cannot approve');

// Ready set (v3.12): waiting cases are left to the judge, unlocked ones are leasable, old ones retire to the agent.
process.env.SANDBOX_BUYER_EMAIL = 'buyer@example.com';
writeFileSync('.junco/pool.json', JSON.stringify([{ buyer_txn: 'C', amount: '48.00', tracking: true, scan: 'Delivered', added: '' }]));
const runs = readRuns();
runs.push({ at: iso(60_000), visitor: 'system', buyer_txn: 'C', kind: 'delivered', scan: 'USPS 9400: Delivered', dispute_id: 'PP-READY' },
  { at: iso(RETIRE_MS + 60_000), visitor: 'system', buyer_txn: 'D', kind: 'unshipped', dispute_id: 'PP-OLD', unlocked_at: iso(RETIRE_MS) });
writeFileSync('.junco/store-runs.json', JSON.stringify(runs));
assert.equal(isWaiting('PP-READY'), true);
assert.match(refusal('ip2', 'delivered')!, /No live cases of this kind left/); // filed but not unlocked yet, pool empty
const retired: string[] = [];
await keepReady({} as any, async (id) => ({ links: [{ rel: 'self' }, { rel: id === 'PP-READY' ? 'provide_supporting_info' : 'x' }] }), (id) => retired.push(id), () => {});
assert.deepEqual(retired, ['PP-OLD']);
assert.equal(isWaiting('PP-OLD'), false);
assert.equal(refusal('ip2', 'delivered'), null);
const leased = as(bob, () => lease('ip2', 'bob', 'delivered'));
assert.equal(leased.dispute_id, 'PP-READY');
assert.equal(isWaiting('PP-READY'), false);
assert.equal(as(bob, () => leaseRefusal('PP-READY')), null);
assert.match(refusal('ip2', 'delivered')!, /One case of each kind/);
assert.deepEqual(extraFor('PP-READY').map((e) => e.source), ['carrier delivery scan (entered by merchant)']);
console.log('ready set: waiting skipped, unlock noticed, 3-day retirement, lease starts now, one per kind, delivery record attached');
console.log('ok');
