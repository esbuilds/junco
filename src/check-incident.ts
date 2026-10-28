// BLACK BOX check, offline, on fixtures in a temp directory (the repo's .junco is never read or written): the incident
// join, missing facts said as missing, the what-if under one changed rule, and that none of it reaches the network
// (globalThis.fetch throws) or imports a PayPal client. The connector tools are called through the gate, as read tools.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// By construction: incident.ts and the two modules it reads through import no PayPal client (type-only imports erase).
const SRC = new URL('.', import.meta.url);
const imports = (f: string) => [...readFileSync(new URL(f, SRC), 'utf8').matchAll(/^import (?!type )[^;]*?from '([^']+)'/gm)].map((m) => m[1]);
assert.deepEqual(imports('incident.ts').sort(), ['./gate.js', './store-dispute.js', 'node:fs', 'zod']);
for (const f of ['gate.ts', 'store-dispute.ts']) assert.ok(!imports(f).some((i) => /disputes|server|agent|hosted|recommend/.test(i)), `${f} imports a PayPal client`);
console.log('imports: incident.ts reaches no PayPal client');

let fetches = 0;
globalThis.fetch = (async () => { fetches++; throw new Error('check-incident: no network'); }) as any;
delete process.env.DATABASE_URL; // no Postgres mirror from a fixture run

const dir = mkdtempSync(join(tmpdir(), 'junco-incident-'));
const POLICY_TEXT = readFileSync('policy.json', 'utf8');
copyFileSync('policy.json', join(dir, 'policy.json'));
process.chdir(dir);
mkdirSync('.junco');
const put = (f: string, v: unknown) => writeFileSync(`.junco/${f}`, JSON.stringify(v));
const A = 'AAAAAAAAAAAAAAAA1', B = 'BBBBBBBBBBBBBBBB2', D = 'PP-D-CHECK1', CAP = 'CAPCHECK1';
const agent = (sku: string, extra = {}) => ({ instruction: `bag ${sku}`, budget: '70', sku, listing: `${sku} listing`, reason: `fits ${sku}`, agent: 'Check shopper', ...extra });
put('pool.json', [
  { buyer_txn: A, amount: '62.00', order_id: 'ORDCHECK1', tracking: false, agent: agent('WKD-01', { capture_id: CAP, paid_at: '2026-10-20T09:56:00.000Z' }), added: '2026-10-20T10:00:00.000Z' },
  { buyer_txn: B, amount: '38.00', order_id: 'ORDCHECK2', tracking: false, agent: agent('WKD-03'), added: '2026-10-21T10:00:00.000Z' },
  { buyer_txn: 'CCCCCCCCCCCCCCCC3', amount: '48.00', tracking: false, added: '2026-10-19T10:00:00.000Z' }, // not an agent order
]);
put('store-runs.json', [{ at: '2026-10-22T10:00:00.000Z', visitor: 'v1', buyer_txn: A, kind: 'agent', dispute_id: D, leased_at: '2026-10-23T10:00:00.000Z' }]);
const amt = (v: string) => ({ value: v, currency_code: 'USD' });
put('holds.json', [
  { id: 'hoffer1', method: 'make_dispute_offer', args: { dispute_id: D, offer_type: 'REFUND', offer_amount: amt('30.00') }, reason: '30 is over the 25 limit for make_dispute_offer',
    created: '2026-10-23T10:05:00.000Z', status: 'completed', ran: '2026-10-23T10:09:00.000Z', result: '{"links":[]}', case: { stage: 'INQUIRY', amount: '62.00 USD' } },
  { id: 'haccept1', method: 'accept_dispute_claim', args: { dispute_id: D, note: 'x' }, reason: 'policy: accept_dispute_claim = hold', created: '2026-10-23T10:06:00.000Z', status: 'rejected' },
  { id: 'hoffer2', method: 'make_dispute_offer', args: { dispute_id: D, offer_type: 'REFUND', offer_amount: amt('40.00') }, reason: '40 is over the 25 limit for make_dispute_offer',
    created: '2026-10-23T10:07:00.000Z', status: 'unknown', ran: '2026-10-23T10:10:00.000Z', result: '{"error":{"type":"outcome_unknown","message":"socket hang up"}}' },
  { id: 'hrefund1', method: 'create_refund', args: { capture_id: CAP, amount: amt('20.00') }, reason: 'policy: create_refund = hold', created: '2026-10-24T10:00:00.000Z',
    status: 'completed', ran: '2026-10-24T10:30:00.000Z', result: '{"id":"RFCHECK1","status":"COMPLETED"}', recheck: { at: '2026-10-24T10:20:00.000Z', event: 'PAYMENT.CAPTURE.REFUNDED' } },
  { id: 'hother1', method: 'accept_dispute_claim', args: { dispute_id: 'PP-OTHER' }, reason: 'policy: accept_dispute_claim = hold', created: '2026-10-23T11:00:00.000Z', status: 'pending' },
]);
put('hold-tags.json', { hoffer1: 'desk agent', hoffer2: "MCP client via PayPal's hosted server", hrefund1: "MCP client via PayPal's hosted server" }); // haccept1 untagged
const MOVE_AT = '2026-10-23T10:01:00.000Z';
put('gate-log.json', [
  { at: MOVE_AT, method: 'make_dispute_offer', args: { dispute_id: D, offer_amount: amt('10.00') }, verdict: 'allow', reason: '10 is within the 25 limit for make_dispute_offer', source: 'desk agent' },
  { at: '2026-10-23T12:00:00.000Z', method: 'make_dispute_offer', args: { dispute_id: 'PP-OTHER', offer_amount: amt('5.00') }, verdict: 'allow', reason: 'x', source: 'MCP client' },
]);
put('activity.json', [{ at: '2026-10-23T10:02:00.000Z', dispute_id: D, trigger: 'webhook', step: 'done', detail: 'offer sent to PayPal.' },
  { at: '2026-10-21T09:57:00.000Z', dispute_id: 'ORDCHECK2', trigger: 'webhook', step: 'watching', detail: 'watching order ORDCHECK2' }, // before B's pool post
  { at: '2026-10-23T10:03:00.000Z', dispute_id: 'PP-OTHER', trigger: 'webhook', step: 'done', detail: 'not ours' }]);

const FILES = readdirSync('.junco').sort();
const { listIncidents, buildIncident, whatIf, addIncidentTools } = await import('./incident.js');

const list = listIncidents();
assert.deepEqual(list.map((i) => i.id), [A, B]); // newest activity first; the non-agent order is not an incident
const a = buildIncident(A)!;
assert.equal(a.dispute_id, D);
assert.deepEqual(a.authority, { instruction: 'bag WKD-01', budget: '70 USD', agent: 'Check shopper' });
assert.equal(a.purchase?.capture_id, CAP);
assert.equal(a.events[0].at, '2026-10-20T09:56:00.000Z'); assert.ok(!a.missing.some((x) => /purchase time/.test(x))); // PayPal's capture time, not the pool post
assert.deepEqual(a.events.map((e) => e.at), a.events.map((e) => e.at).sort()); // oldest first
const modes = Object.fromEntries(a.events.map((e) => [e.id, e.mode]));
assert.deepEqual(modes, { [`purchase:${A}`]: 'live', [`dispute:${D}`]: 'live', [`dispute:${D}:leased`]: 'recorded', 'agent:2026-10-23T10:02:00.000Z': 'recorded',
  [`gate:${MOVE_AT}`]: 'live', 'hold:hoffer1': 'recorded', 'approval:hoffer1': 'recorded', 'paypal:hoffer1': 'live', 'hold:haccept1': 'recorded', 'approval:haccept1': 'recorded',
  'hold:hoffer2': 'recorded', 'approval:hoffer2': 'recorded', 'paypal:hoffer2': 'live', 'hold:hrefund1': 'recorded', 'webhook:hrefund1': 'live', 'approval:hrefund1': 'recorded', 'paypal:hrefund1': 'live' });
assert.deepEqual([...new Set(a.events.map((e) => e.kind))].sort(), ['agent', 'approval', 'dispute', 'gate', 'hold', 'paypal', 'purchase', 'webhook']);
assert.ok(!JSON.stringify(a).includes('PP-OTHER') && !a.events.some((e) => e.ref?.hold_id === 'hother1')); // nothing from another case
assert.equal(a.events.find((e) => e.id === 'paypal:hrefund1')?.ref?.refund_id, 'RFCHECK1'); // PayPal's refund id, from the hold's result
assert.match(a.events.find((e) => e.id === 'paypal:hrefund1')!.summary, /RFCHECK1 \(COMPLETED\)/);
assert.equal(a.events.find((e) => e.id === 'hold:hrefund1')?.actor, "MCP client via PayPal's hosted server");
assert.equal(a.events.find((e) => e.id === `gate:${MOVE_AT}`)?.ref?.rule, 'allow: 10 is within the 25 limit for make_dispute_offer'); // the verdict leads the rule (the desk's LIVE label)
assert.ok(a.events.filter((e) => e.kind === 'hold').every((e) => e.ref?.rule?.startsWith('hold: ')));
assert.deepEqual(a.counts, { proposed: 5, approved: 4, executed: 3, outcome_unknown: 1 });
for (const m of [/who asked for hold haccept1/, /when hold haccept1 was rejected/, /whether hold hoffer2 reached PayPal/]) assert.ok(a.missing.some((x) => m.test(x)), `missing ${m}`);
assert.ok(!a.missing.some((x) => /capture id/.test(x)));
const b = buildIncident(B)!;
assert.equal(b.dispute_id, null); assert.equal(b.purchase?.capture_id, undefined);
assert.ok(b.missing.some((x) => /^capture id: .*ORDCHECK2/.test(x)) && b.missing.some((x) => /^dispute: none filed/.test(x)));
assert.equal(b.events[0].kind, 'purchase'); assert.equal(b.events[0].at, '2026-10-21T10:00:00.000Z'); // first, though the watch event's clock is earlier
assert.ok(b.missing.includes('purchase time: not recorded; shown at the time the desk received it'));
assert.equal(buildIncident('ZZZZZZZZZZZZZZZZZ'), null);
assert.equal(buildIncident('ORDCHECK1')?.id, A); assert.equal(buildIncident(CAP)?.id, A); assert.equal(buildIncident('ORDCHECK2')?.id, B); // order or capture id, exact
assert.equal(buildIncident('ORDCHECK'), null); assert.equal(buildIncident('ordcheck1'), null);
console.log('join: pool, store runs, holds, gate log and activity in one story; missing facts listed, never filled');

const refund = whatIf('hold:hrefund1', { max_amount: 50 });
assert.deepEqual([refund.before.verdict, refund.after.verdict, refund.paypal_calls, refund.mode], ['hold', 'allow', 0, 'what-if']);
assert.equal(refund.change, 'create_refund limit none (hold) -> 50 USD');
const offer = whatIf('hold:hoffer1', { max_amount: 40 });
assert.equal(offer.change, 'make_dispute_offer limit 25 USD -> 40 USD'); assert.equal(offer.after.verdict, 'allow');
assert.equal(whatIf(`gate:${MOVE_AT}`, { max_amount: 5 }).after.verdict, 'hold');
const budget = whatIf('hold:haccept1', { budget: 100 }); // accept moves the whole 62.00 from the pool order
assert.deepEqual([budget.after.verdict, budget.after.reason], ['allow', `within the 100 USD standing approval for ${D}`]);
assert.equal(whatIf('hold:haccept1', { budget: 50 }).after.verdict, 'hold');
assert.throws(() => whatIf('hold:hrefund1', { budget: 100 }), /names no dispute_id/);
assert.throws(() => whatIf('hold:haccept1', { max_amount: 100 }), /no amount limit/);
assert.throws(() => whatIf('hold:nope', { max_amount: 1 }), /No recorded request/);
assert.equal(readFileSync('policy.json', 'utf8'), POLICY_TEXT); assert.ok(!readFileSync('.junco/holds.json', 'utf8').includes('what-if')); // nothing saved
assert.deepEqual(readdirSync('.junco').sort(), FILES); // no policy or budget file written
console.log('what-if: one changed rule re-runs decide() on the recorded request; nothing saved');

// The tools, through the gate exactly as createHostedServer wires them: classed read, so they pass straight through.
const { gate, loadPolicy } = await import('./gate.js');
const policy = loadPolicy();
for (const t of ['junco_list_incidents', 'junco_get_incident', 'junco_what_if']) assert.equal(policy.tools[t], 'read');
const server = new McpServer({ name: 'check-incident', version: '0' });
addIncidentTools(server);
gate(server, policy);
const [x, y] = InMemoryTransport.createLinkedPair();
await server.connect(x);
const client = new Client({ name: 'check', version: '0' });
await client.connect(y);
const call = async (name: string, args: any) => { const r: any = await client.callTool({ name, arguments: args }); return { err: !!r.isError, body: JSON.parse(r.content[0].text) }; };
assert.equal((await call('junco_list_incidents', {})).body.length, 2);
assert.equal((await call('junco_get_incident', { id: A })).body.dispute_id, D);
assert.equal((await call('junco_what_if', { event_id: 'hold:hrefund1', max_amount: 50 })).body.after.verdict, 'allow');
assert.ok((await call('junco_what_if', { event_id: 'hold:hrefund1', max_amount: 50, budget: 1 })).err);
assert.equal(JSON.parse(readFileSync('.junco/holds.json', 'utf8')).length, 5); // no tool call made a hold
await client.close();
// The toolkit path (/mcp) carries them too: PayPal's hosted calls can fail while the toolkit's REST calls work (Oct 28).
const { createServer } = await import('./server.js');
const { server: toolkit } = await createServer({ accessToken: 'offline', baseUrl: 'http://offline', token: async () => 'offline' } as any, policy);
for (const t of ['junco_list_incidents', 'junco_get_incident', 'junco_what_if', 'junco_hold_status']) assert.ok((toolkit as any)._registeredTools[t], `/mcp lacks ${t}`);
console.log('tools: three read tools pass the gate; no hold made; /mcp has them and the hold card too');

// Backfill: a re-posted pool entry gives an old agent record its capture_id, and changes nothing else.
const { addToPool, readPool } = await import('./store-dispute.js');
const before = readPool();
assert.deepEqual(addToPool([{ buyer_txn: B, amount: '99', order_id: 'X', agent: { capture_id: 'CAPCHECK2', paid_at: '2026-10-21T09:55:00Z', sku: 'X' } },
  { buyer_txn: A, amount: '62', agent: { capture_id: 'CAPOTHER', paid_at: '2026-10-01T00:00:00Z' } }, { buyer_txn: 'CCCCCCCCCCCCCCCC3', amount: '48', agent: { capture_id: 'CAPX' } }]), { added: 0, backfilled: 1 });
assert.deepEqual(readPool(), before.map((p) => (p.buyer_txn === B ? { ...p, agent: { ...p.agent!, capture_id: 'CAPCHECK2', paid_at: '2026-10-21T09:55:00.000Z' } } : p)));
assert.ok(!buildIncident(B)!.missing.some((x) => /capture id/.test(x)) && buildIncident(A)!.purchase?.capture_id === CAP);
assert.equal(buildIncident(B)!.events[0].at, '2026-10-21T09:55:00.000Z'); assert.ok(!buildIncident(B)!.missing.some((x) => /purchase time/.test(x)));
assert.equal(addToPool([{ buyer_txn: B, amount: '38', agent: { capture_id: 'bad id!' } }]).backfilled, 0);
const bad = ['2026-10-21', '2026-10-21T09:55:00+02:00', 'yesterday', '2026-13-40T25:00:00Z'];
assert.equal(addToPool(bad.map((t, i) => ({ buyer_txn: `BADTIME00000000${i}X`, amount: '1', agent: { ...agent('X'), paid_at: t } }))).added, 4);
assert.ok(readPool().filter((p) => p.buyer_txn.startsWith('BADTIME')).every((p) => p.agent && !('paid_at' in p.agent))); // ISO UTC only
// Two purchases sharing an order id (a bad post): none, said plainly, never a guess.
writeFileSync('.junco/pool.json', JSON.stringify([...readPool(), { buyer_txn: 'DUPDUPDUPDUPDUP01', amount: '5.00', order_id: 'ORDCHECK1', agent: agent('DUP'), added: '2026-10-25T10:00:00.000Z' }]));
assert.throws(() => buildIncident('ORDCHECK1'), (e: any) => e.code === 404 && /ORDCHECK1 matches 2 purchases \(AAAAAAAAAAAAAAAA1, DUPDUPDUPDUPDUP01\); ask by buyer transaction id/.test(e.message));
assert.equal(buildIncident(A)?.id, A); // the buyer transaction id still resolves
console.log('lookup: buyer transaction, order or capture id, exact; an id two purchases share returns none and says so');
console.log('backfill: a missing capture_id or paid_at is set from the post (ISO UTC only); existing ones and every other field stay');
console.log('purchase: at PayPal capture time when recorded, else the pool post time and said so in missing; always first');

assert.equal(fetches, 0);
console.log('incident: ok (0 network calls)');
