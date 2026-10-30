// "Your AI buys, you investigate" check, offline, on fixtures in a temp directory: /api/shop's visitorShop() with a fake
// fetch standing in for Claude and PayPal. The missing vault and bad input stop before Claude, the store's price guard
// stops before PayPal, both caps hold, a decline and a declined payment say so, a buy becomes an incident keyed by its
// capture id with no buyer transaction id, and one visitor's runs never list for another.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pool = readFileSync('src/pool.ts', 'utf8'), desk = readFileSync('src/desk.ts', 'utf8');
assert.ok(pool.includes('await charge(ctx, choice.sku, ask.budget, vaultId, ask.instruction)') && !pool.includes("'/v2/checkout/orders', { headers: { 'PayPal-Request-Id'"), 'pool.ts no longer uses the shared charge()');
assert.ok(desk.includes('await visitorShop(ctx, { session, owner, instruction: b?.instruction, budget: b?.budget })'), 'the desk no longer routes /api/shop to visitorShop');
console.log('wiring: pool.ts charges through charge(); /api/shop calls visitorShop()');

// Fake Claude and PayPal. `agent` is the shopping agent's next tool call; `paypalAnswer` PayPal's next order response.
let agent: { name: string; input: any } = { name: 'decline', input: { reason: 'x' } }, paypalAnswer: { status: number; body: any } = { status: 500, body: {} };
const calls = { claude: 0, paypal: 0 }, orders: any[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.includes('anthropic')) {
    calls.claude++;
    return new Response(JSON.stringify({ id: 'msg_check', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'tu_check', ...agent }], usage: { input_tokens: 300, output_tokens: 40 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // charge() reads the order back after the capture (a GET): PayPal's copy echoes the custom_id and invoice_id it was sent.
  if (u.startsWith('http://paypal.check/') && init?.method === 'GET') { const pu = orders.at(-1).purchase_units[0]; return new Response(JSON.stringify({ id: 'ORDSHOP1', purchase_units: [{ custom_id: pu.custom_id, invoice_id: pu.invoice_id }] }), { status: 200 }); }
  if (u.startsWith('http://paypal.check/')) { calls.paypal++; orders.push(JSON.parse(init.body)); return new Response(JSON.stringify(paypalAnswer.body), { status: paypalAnswer.status }); }
  throw new Error(`check-shop: no network (${u})`);
}) as any;
delete process.env.DATABASE_URL;
process.env.ANTHROPIC_API_KEY = 'check';
delete process.env.SHOP_PER_SESSION; delete process.env.SHOP_PER_DAY;

const dir = mkdtempSync(join(tmpdir(), 'junco-shop-'));
copyFileSync('policy.json', join(dir, 'policy.json'));
process.chdir(dir);
mkdirSync('.junco');

const { charge, visitorShop, shopLeft } = await import('./shopper.js');
const { actor, readAgentBuys, readDeclines } = await import('./store-dispute.js');
const { listIncidents, buildIncident } = await import('./incident.js');
const ctx = { baseUrl: 'http://paypal.check', token: async () => 'check' };
const shopAs = (session: string, instruction: unknown, budget: unknown, owner = false) => visitorShop(ctx, { session, owner, instruction, budget });
const fails = async (p: Promise<unknown>, code: number, re: RegExp) => { await assert.rejects(p, (e: any) => e.code === code && re.test(e.message)); };
const A = 'a'.repeat(36), B = 'b'.repeat(36), C = 'c'.repeat(36);

// No vault: refused plainly before anything else, Claude included.
delete process.env.AGENT_VAULT_ID;
await fails(shopAs(A, 'a waterproof bag', 70), 400, /^Shopping is off on this desk\.$/);
process.env.AGENT_VAULT_ID = 'VAULTCHECK';
// Input limits, before the caps and Claude.
await fails(shopAs(A, 'x', 70), 400, /3 to 200 characters/);
await fails(shopAs(A, 'y'.repeat(201), 70), 400, /3 to 200 characters/);
await fails(shopAs(A, { evil: 1 }, 70), 400, /3 to 200 characters/);
await fails(shopAs(A, 'a bag', 81), 400, /from 1 to 80/);
await fails(shopAs(A, 'a bag', 'lots'), 400, /from 1 to 80/);
assert.deepEqual(calls, { claude: 0, paypal: 0 }); assert.equal(shopLeft(A).you, 2);
console.log('guards: no vault and bad input refused before Claude; nothing counted');

// The store's price guard: the catalog price decides, never the agent; over the budget, PayPal is never called.
assert.deepEqual(await charge(ctx, 'WKD-02', '70.00', 'VAULTCHECK', 'a bag'), { refused: "store refused WKD-02 at $74.00: over the agent's $70.00 budget" });
assert.deepEqual(await charge(ctx, 'NOPE', '70.00', 'VAULTCHECK', 'a bag'), { refused: 'store refused NOPE: not in the catalog' });
agent = { name: 'buy', input: { sku: 'WKD-02', reason: 'waterproof' } };
await fails(shopAs(A, 'a waterproof bag for kayaking', 70), 400, /The store refused it: your agent picked WKD-02, which costs more than your \$70\.00 budget\. Nothing was bought\./);
assert.equal(calls.paypal, 0); assert.equal(calls.claude, 1);
console.log('price guard: WKD-02 at $74 over a $70 budget never reaches PayPal');

// A buy: the order is the catalog's price on the saved account, and the incident is keyed by its capture id.
agent = { name: 'buy', input: { sku: 'WKD-01', reason: 'a nice carry-on under budget' } };
paypalAnswer = { status: 201, body: { id: 'ORDSHOP1', purchase_units: [{ payments: { captures: [{ id: 'CAPSHOP1', create_time: '2026-10-29T18:00:00Z' }] } }] } };
const r = await shopAs(A, '  a nice   carry-on  ', 70);
assert.deepEqual(r, { id: 'CAPSHOP1', bought: true, text: 'Your agent bought Waxed canvas weekender for $62.00: a nice carry-on under budget' });
const sent = orders.at(-1);
assert.equal(sent.purchase_units[0].amount.value, '62.00'); assert.equal(sent.payment_source.paypal.vault_id, 'VAULTCHECK');
assert.equal(readAgentBuys()[0].session, A); assert.equal(readAgentBuys()[0].agent.instruction, 'a nice carry-on'); assert.equal(readAgentBuys()[0].agent.budget, '70.00');
assert.ok(!existsSync('.junco/pool.json')); // never in the dispute pool
const inc = buildIncident('CAPSHOP1')!;
assert.equal(inc.id, 'CAPSHOP1'); assert.equal(buildIncident('ORDSHOP1')?.id, 'CAPSHOP1');
assert.deepEqual(inc.purchase, { sku: 'WKD-01', listing: inc.purchase!.listing, reason: 'a nice carry-on under budget', amount: '62.00 USD', order_id: 'ORDSHOP1', capture_id: 'CAPSHOP1' });
assert.equal(inc.dispute_id, null);
assert.deepEqual(inc.events[0].ref, { order_id: 'ORDSHOP1', capture_id: 'CAPSHOP1' }); // no buyer_txn
assert.equal(inc.events[0].source, 'agent-buys'); assert.equal(inc.events[0].at, '2026-10-29T18:00:00Z');
assert.ok(inc.missing.some((m) => /^buyer transaction id: .*keyed by the capture id and cannot be disputed/.test(m)) && !inc.missing.some((m) => /^dispute:/.test(m)));
// The mandate fingerprint went into PayPal's order and, read back, matches the store's record.
const fp = readAgentBuys()[0].agent.mandate!.fingerprint;
assert.match(sent.purchase_units[0].custom_id, new RegExp(`^junco:m:${fp}$`)); assert.match(sent.purchase_units[0].invoice_id, new RegExp(`^JUNCO-M-${fp}-\\d{12}$`));
assert.match(inc.events.find((e) => e.kind === 'paypal_fingerprint')!.summary, /carries the fingerprint of what the buyer allowed.*reproduces it/);
console.log('buy: catalog price on the saved account; incident by capture id (or order id), no buyer txn, said as missing; fingerprint at PayPal matches');

// Per-session cap: two runs that reached Claude (the refusal counted too); the third is refused before Claude. The owner skips it.
const before = calls.claude;
await fails(shopAs(A, 'another bag', 70), 429, /last shopping run today \(2 a visitor\)/);
assert.equal(calls.claude, before);

// A decline from another visitor: recorded as theirs.
agent = { name: 'decline', input: { reason: 'Nothing waterproof under $40.' } };
const d = await shopAs(B, 'a waterproof bag', 40);
assert.equal(d.bought, false); assert.ok(d.id.startsWith('decline-'));
assert.equal(readDeclines()[0].session, B); assert.equal(buildIncident(d.id)?.decline?.reason, 'Nothing waterproof under $40.');

// A declined payment: "the store could not charge", nothing recorded as bought.
agent = { name: 'buy', input: { sku: 'WKD-03', reason: 'cheap' } };
paypalAnswer = { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] } };
await fails(shopAs(B, 'a cheap bag', 40), 502, /^The store could not charge the saved PayPal account: PayPal declined the payment\. Nothing was bought\.$/);
assert.equal(readAgentBuys().length, 1);
console.log('outcomes: a decline is the visitor\'s incident; a declined payment says the store could not charge');

// Owner: past the per-session cap. Desk-wide cap: refused for everyone, owner included, before Claude.
agent = { name: 'decline', input: { reason: 'no' } };
assert.equal((await shopAs(A, 'one more', 70, true)).bought, false);
process.env.SHOP_PER_DAY = '5'; // 5 runs reached Claude today
const n = calls.claude;
await fails(shopAs(C, 'a bag', 70), 429, /had its runs for today/);
await fails(shopAs(C, 'a bag', 70, true), 429, /had its runs for today/);
assert.equal(calls.claude, n);
delete process.env.SHOP_PER_DAY;
console.log('caps: 2 per visitor (owner exempt), the daily cap for everyone, both before Claude');

// Privacy: each visitor lists only their own runs; the owner lists all; no session (a connector without one) lists none.
const ids = (who?: { owner: boolean; session: string }) => (who ? actor.run(who, listIncidents) : listIncidents()).map((i) => i.id).sort();
const ownA = [r.id, readDeclines().find((x) => x.session === A)!.id].sort();
assert.deepEqual(ids({ owner: false, session: A }), ownA);
assert.deepEqual(ids({ owner: false, session: B }), [d.id]);
assert.deepEqual(ids({ owner: false, session: C }), []);
assert.deepEqual(ids(), []);
assert.equal(ids({ owner: true, session: 'o' }).length, 3);
assert.equal(actor.run({ owner: false, session: B }, () => buildIncident('CAPSHOP1'))?.id, 'CAPSHOP1'); // the link opens for anyone
console.log('privacy: listed for the visitor and the owner only; the page opens by its link');
console.log('shop: ok (Claude and PayPal faked, 0 real network calls)');
