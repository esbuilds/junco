// D1 lease check, offline: who may write on a pool case, at the gate and on hold approvals. Runs in a temp directory.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'junco-lease-')));
delete process.env.DATABASE_URL; // nothing mirrored
const { actor, leaseRefusal, LEASE_MS } = await import('./store-dispute.js');
const { gate, guards } = await import('./gate.js');

mkdirSync('.junco');
const now = Date.now();
writeFileSync('.junco/store-runs.json', JSON.stringify([
  { at: new Date(now - 60_000).toISOString(), visitor: 'ip', session: 'alice', buyer_txn: 'A', dispute_id: 'PP-LIVE' },
  { at: new Date(now - LEASE_MS - 60_000).toISOString(), visitor: 'ip', session: 'alice', buyer_txn: 'B', dispute_id: 'PP-PAST' },
]));
const as = <T>(who: { owner: boolean; session: string } | null, f: () => T) => (who ? actor.run(who, f) : f());
const alice = { owner: false, session: 'alice' }, bob = { owner: false, session: 'bob' }, owner = { owner: true, session: 'x' };

assert.equal(as(alice, () => leaseRefusal('PP-LIVE')), null);
assert.match(as(bob, () => leaseRefusal('PP-LIVE'))!, /leased to another visitor/);
assert.match(as(alice, () => leaseRefusal('PP-PAST'))!, /past runs are read-only/);
assert.equal(as(owner, () => leaseRefusal('PP-PAST')), null);
assert.equal(as(null, () => leaseRefusal('PP-LIVE')), null); // webhooks and timers: the system
assert.equal(as(bob, () => leaseRefusal('PP-R-VQB')), null); // not a pool case
console.log('lease: holder, other visitor, ended run, owner, system, non-pool case');

// Through the gate: a held write by the holder; another visitor is refused before policy, and can't approve the hold.
guards.push((_m, args) => leaseRefusal(args?.dispute_id));
let calls = 0;
const fake: any = { _registeredTools: { accept_dispute_claim: { handler: async () => { calls++; return { content: [{ type: 'text', text: '{}' }] }; }, update(u: any) { this.handler = u.callback; } } } };
const g = gate(fake, { default: 'deny', tools: { accept_dispute_claim: 'hold' } });
const call = () => fake._registeredTools.accept_dispute_claim.handler({ dispute_id: 'PP-LIVE' }, {}).then((r: any) => JSON.parse(r.content[0].text));
assert.equal((await as(bob, call)).error?.type, 'denied_by_guard');
const held = await as(alice, call);
assert.equal(held.held, true);
await assert.rejects(as(bob, () => g.approve(held.hold_id)), /leased to another visitor/);
assert.equal((await as(alice, () => g.approve(held.hold_id))).status, 'completed');
assert.equal(calls, 1);
console.log('gate: other visitor denied, holder held then approved, other visitor cannot approve');
console.log('ok');
