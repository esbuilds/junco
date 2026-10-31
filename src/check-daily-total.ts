// The gate's daily total on the desk's side, offline, in a temp directory: the real src/gate.ts and policy.json in front of fake
// PayPal tools. Two gates share one total (the desk's server and the hosted one), a standing accept counts at the disputed amount,
// PayPal's own error shapes decide what releases, an owner's saved policy can't drop the total, and the replays say what they can't
// re-run. The total's own rules (concurrency, restart, midnight) are in check-gate-pkg.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definiteRefusal } from '../packages/junco-gate/src/paypal.js';

const REPO = process.cwd();
assert.ok(readFileSync('src/gate.ts', 'utf8').includes("jsonTotal('.junco/daily-total.json', mirror)"), 'the total must be mirrored like the other stores');
assert.ok(readFileSync('src/desk.ts', 'utf8').includes('daily_total: dailyTotalView(policy)'), 'the Gate record no longer shows the total');
assert.ok(readFileSync('studio/src/widgets/GateRecordWidget.tsx', 'utf8').includes('Approved in advance today'), 'the owner no longer sees the total');
assert.doesNotMatch(readFileSync('studio/src/widgets/GateRecordWidget.tsx', 'utf8'), /money out|spent today/i, 'offers count though no money moves');

// PayPal's shapes: only a 4xx or a stop before PayPal is definite. A 5xx or no answer may have landed.
const refused = ['{"ok":false,"status":422,"code":"PAYPAL_API_HTTP_ERROR","message":"nope"}', '{"error":{"message":"PayPal 422","details":{}}}', '{"error":{"message":"Could not load dispute (404)"}}',
  '{"error":{"message":"PayPal does not allow make_offer on this dispute now","type":"action_not_allowed"}}', '{"error":{"message":"bad","type":"invalid_arguments"}}'];
const open = ['{"ok":false,"status":500,"code":"PAYPAL_API_HTTP_ERROR","message":"oops"}', '{"ok":false,"code":"PAYPAL_API_NO_RESPONSE","message":"timeout"}', '{"error":{"message":"PayPal 503"}}', '{"error":{"message":"Could not load dispute (500)"}}',
  '{"error":{"type":"upstream_unavailable","message":"no answer"}}', '{"error":{"type":"paypal_error","message":"socket hang up"}}', 'not json', ''];
for (const t of refused) assert.equal(definiteRefusal(t), true, t);
for (const t of open) assert.equal(definiteRefusal(t), false, t);
console.log(`refusals: ${refused.length} shapes release, ${open.length} that may have landed keep`);

delete process.env.DATABASE_URL;
process.chdir(mkdtempSync(join(tmpdir(), 'junco-total-')));
copyFileSync(join(REPO, 'policy.json'), 'policy.json');
mkdirSync('.junco');
const shipped = JSON.parse(readFileSync('policy.json', 'utf8'));
assert.deepEqual(shipped.daily_total, { max: 100, over: 'hold' });
const agent = { instruction: 'a bag', budget: '70.00', sku: 'WKD-01', listing: 'WKD-01 listing', reason: 'fits', agent: 'Check shopper', capture_id: 'CAPX', paid_at: '2026-10-29T18:00:00.000Z' };
writeFileSync('.junco/pool.json', JSON.stringify([{ buyer_txn: 'TXN1', amount: '62.00', order_id: 'ORD1', added: '2026-10-29T18:00:01.000Z', agent }]));
writeFileSync('.junco/store-runs.json', JSON.stringify([{ at: '2026-10-29T19:00:00.000Z', visitor: 'x', buyer_txn: 'TXN1', dispute_id: 'PP-1' }]));

const { dailyTotalView, gate, loadActivePolicy, loadPolicy, readHolds, savePolicy, setBudget } = await import('./gate.js');
const { buildIncident, NO_TOTAL, replay, whatIf } = await import('./incident.js');
const { bookRow } = await import('./books.js');

// Two gated servers, as the desk runs them: every call lands in one total, whichever server it came through.
const policy = loadActivePolicy();
let sent = 0, answer = '{"ok":true,"status":200}';
async function served(origin?: string) {
  const server = new McpServer({ name: 'check', version: '0' });
  for (const name of ['make_dispute_offer', 'accept_dispute_claim', 'create_refund', 'send_dispute_message'])
    server.registerTool(name, { description: name, inputSchema: { dispute_id: z.string().optional(), capture_id: z.string().optional(), offer_amount: z.any().optional(), amount: z.any().optional(), note: z.string().optional() } },
      async () => { sent++; return { content: [{ type: 'text', text: answer }] }; });
  const g = gate(server, policy, undefined, undefined, origin);
  const [x, y] = InMemoryTransport.createLinkedPair();
  await server.connect(x);
  const client = new Client({ name: 'check', version: '0' });
  await client.connect(y);
  return { client, call: async (name: string, args: any) => JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text), g };
}
const offer = (id: string, value: string, currency_code = 'USD') => ({ dispute_id: id, offer_amount: { value, currency_code } });
const desk = await served(), hosted = await served('paypal-hosted');
assert.equal(dailyTotalView(policy)!.approved_in_advance, '0.00');

const view = () => dailyTotalView(policy)!;
assert.ok((await desk.call('make_dispute_offer', offer('A', '25.00'))).ok);
assert.ok((await hosted.call('make_dispute_offer', offer('B', '25.00'))).ok);
assert.deepEqual([view().approved_in_advance, view().max, view().calls, view().currency], ['50.00', 100, 2, 'USD']);
// PayPal refuses one: it gives back. PayPal 500: it stays.
answer = '{"error":{"message":"PayPal 422"}}';
await desk.call('make_dispute_offer', offer('C', '25.00'));
assert.equal(view().approved_in_advance, '50.00');
answer = '{"error":{"message":"PayPal 500"}}';
await desk.call('make_dispute_offer', offer('D', '10.00'));
assert.equal(view().approved_in_advance, '60.00');
answer = '{"ok":true,"status":200}';
console.log('both servers share one total; a 422 releases, a 500 keeps');

// A standing approval counts, with an accept at the disputed amount.
setBudget('PP-1', { limit: 100, amount: 62, currency: 'USD', set_at: '2026-10-30T00:00:00.000Z' });
const accept = await desk.call('accept_dispute_claim', { dispute_id: 'PP-1' });
assert.ok(accept.held, 'at 60.00, an accept of 62.00 passes the total though its standing approval allows it');
const heldId = accept.hold_id;
assert.match(accept.reason, /daily total was reached: 60\.00 of 100 USD approved in advance today \(UTC\), and this 62\.00 would pass it/);
assert.doesNotMatch(accept.reason, /money out|spent/i);
assert.equal(readHolds().find((h) => h.id === heldId)!.status, 'pending');
writeFileSync('.junco/daily-total.json', JSON.stringify({ day: new Date().toISOString().slice(0, 10), cents: 0, calls: 0 }));
assert.ok((await hosted.call('accept_dispute_claim', { dispute_id: 'PP-2' })).held, 'no standing approval: held by policy');
assert.equal(view().approved_in_advance, '0.00');
setBudget('PP-3', { limit: 100, amount: 62, currency: 'USD', set_at: '2026-10-30T00:00:00.000Z' });
assert.ok((await desk.call('accept_dispute_claim', { dispute_id: 'PP-3' })).ok);
assert.equal(view().approved_in_advance, '62.00');
setBudget('PP-4', { limit: 10, amount: 62, currency: 'USD', set_at: '2026-10-30T00:00:00.000Z' });
assert.ok((await desk.call('make_dispute_offer', offer('PP-4', '8.00'))).ok, 'an offer inside a standing approval counts at its own amount');
assert.equal(view().approved_in_advance, '70.00');
await desk.call('send_dispute_message', { dispute_id: 'A', note: 'hello' });
assert.equal(view().calls, 2, 'a message counts for nothing');
// Another currency holds; a refund the owner set to run outright counts, and a full refund with no amount holds.
assert.match((await desk.call('make_dispute_offer', offer('E', '5.00', 'EUR'))).reason, /in USD and this call is in EUR/);
policy.tools.create_refund = 'allow';
const allowed = await served();
assert.ok((await allowed.call('create_refund', { capture_id: 'CAP1', amount: { value: '10.00', currency_code: 'USD' } })).ok);
assert.equal(view().approved_in_advance, '80.00');
assert.match((await allowed.call('create_refund', { capture_id: 'CAP2' })).reason, /no readable amount/);
const listedAllow = (await allowed.client.listTools()).tools.find((t) => t.name === 'create_refund')!.description!;
assert.match(listedAllow, /^Through this server, this call runs directly\. The owner also set a daily total/);
policy.tools.create_refund = 'hold';
console.log('a standing accept counts at the disputed amount, an offer at its own, other currencies and unknown amounts hold');

// Clients are told, on the real policy.
const listed = Object.fromEntries((await desk.client.listTools()).tools.map((t) => [t.name, t.description!]));
for (const t of ['make_dispute_offer', 'accept_dispute_claim', 'create_refund']) assert.match(listed[t], /may add up to 100 USD a UTC day/, t);
assert.doesNotMatch(listed.send_dispute_message, /daily total/);
assert.match(desk.client.getInstructions() ?? '', /100 USD a UTC day/);

// Replays can't re-run the total, and say so; a hold the total made doesn't read as a rule that changed.
assert.equal(whatIf(`hold:${heldId}`, { budget: 90 }).note, NO_TOTAL);
const r = replay(`hold:${heldId}`)!;
assert.deepEqual([r.before, r.after, r.by_total], ['hold', 'allow', true]);
const row = bookRow(buildIncident('TXN1')!, '2026-10-30T00:00:00.000Z');
assert.equal(row.replay, 'Same today'); assert.ok(row.replay_detail.endsWith(NO_TOTAL), row.replay_detail);
console.log('junco_what_if and the Books replay say what they cannot re-run; a total hold is not "Changed today"');

// An owner's saved policy (older than the total, or edited on the desk) can't drop it; removing it from the repo turns it off.
writeFileSync('.junco/policy.json', JSON.stringify({ default: 'deny', tools: { make_dispute_offer: { max_amount: 10, over: 'hold' } } }));
assert.deepEqual(loadActivePolicy().daily_total, { max: 100, over: 'hold' });
assert.deepEqual(savePolicy({ ...loadActivePolicy() }).daily_total, { max: 100, over: 'hold' });
const { daily_total: _, ...off } = loadPolicy();
writeFileSync('policy.json', JSON.stringify(off));
assert.equal(loadActivePolicy().daily_total, undefined); assert.equal(dailyTotalView(loadActivePolicy()), null);
assert.equal(whatIf(`hold:${heldId}`, { budget: 90 }).note, undefined, 'no total, no note');
assert.ok(existsSync('.junco/daily-total.json'));
console.log('saved policy: the repo\'s daily total always applies; off when absent');

console.log(`check-daily-total: pass (${sent} calls reached the fake PayPal, none of them real)`);
