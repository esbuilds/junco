// BLACK BOX declines, offline, on fixtures in a temp directory: when the shopping agent buys nothing, pool.ts posts the
// decline with the pool, the desk keeps it (once, never in the dispute pool), and it comes back as an incident with no
// purchase and no money moves, on the connector tools, the receipt, the page and the what-if without an "undefined".
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// The producer side, by source: pool.ts records a decline and posts it; the desk's /api/pool stores it.
const pool = readFileSync('src/pool.ts', 'utf8'), desk = readFileSync('src/desk.ts', 'utf8'), page = readFileSync('public/incident.html', 'utf8');
assert.ok(/if \('declined' in choice\) \{\s*\/\/[^\n]*\n\s*declines\.push\(/.test(pool), 'pool.ts no longer records a decline');
assert.ok(pool.includes('JSON.stringify({ entries, declines })'), 'pool.ts no longer posts declines to the desk');
assert.ok(desk.includes('addDeclines(Array.isArray(body?.declines) ? body.declines : [])'), "the desk's /api/pool no longer stores declines");
console.log('producer: pool.ts records and posts a decline; /api/pool stores it');

let fetches = 0;
globalThis.fetch = (async () => { fetches++; throw new Error('check-decline: no network'); }) as any;
delete process.env.DATABASE_URL;
const dir = mkdtempSync(join(tmpdir(), 'junco-decline-'));
copyFileSync('policy.json', join(dir, 'policy.json'));
process.chdir(dir);
mkdirSync('.junco');
const A = 'AAAAAAAAAAAAAAAA1';
writeFileSync('.junco/pool.json', JSON.stringify([{ buyer_txn: A, amount: '62.00', order_id: 'ORDCHECK1', tracking: false, added: '2026-10-28T10:00:00.000Z',
  agent: { instruction: 'bag', budget: '70.00', sku: 'WKD-01', listing: 'WKD-01 listing', reason: 'fits', agent: 'Check shopper', capture_id: 'CAPCHECK1', paid_at: '2026-10-28T09:56:00.000Z' } }]));

const { addDeclines, readDeclines, readPool } = await import('./store-dispute.js');
const { listIncidents, buildIncident, whatIf, addIncidentTools } = await import('./incident.js');
const { receiptPage } = await import('./incident-view.js');
const { NOTHING_BOUGHT, notInRecords, reachedPayPal, whatIfPreset } = await import('./incident-questions.js');

// What pool.ts sends for the Oct 28 case: kayaking under $70, and the only waterproof bag is $74.
const LISTINGS = ['WKD-01 Waxed canvas weekender, $62.00. Not waterproof.', 'WKD-02 Rolltop dry duffel, $74.00. Waterproof.', 'WKD-03 Packable nylon weekender, $38.00. Light rain only.'];
const sent = { at: '2026-10-28T15:30:12.345Z', instruction: 'Get me a waterproof weekend bag I can take kayaking, under $70.', budget: '70.00',
  reason: 'The only waterproof bag, WKD-02, costs $74, over the $70 budget.', agent: 'Check shopper', listings: LISTINGS };
assert.equal(addDeclines([sent, { ...sent, at: 'not a time' }, { ...sent, at: '2026-10-28T16:00:00Z', reason: '' }, null]), 1);
assert.equal(addDeclines([sent]), 0); // a re-post adds nothing
assert.equal(readDeclines().length, 1);
assert.equal(readPool().length, 1); // never in the dispute pool
const ID = 'decline-20261028153012345';
assert.equal(readDeclines()[0].id, ID);
assert.ok(!/^[A-Z0-9]{17}$/.test(ID) && /^[A-Za-z0-9_-]{15,32}$/.test(ID)); // never a buyer txn id; the connector's id pattern takes it
console.log('store: kept once, bad entries dropped, not in the pool');

const list = listIncidents();
assert.deepEqual(list.map((i) => i.id), [ID, A]); // newest first, alongside purchases
assert.deepEqual(list[0].counts, { proposed: 0, approved: 0, executed: 0, outcome_unknown: 0 });
const d = buildIncident(ID)!;
assert.equal(d.title, `Agent bought nothing for "${sent.instruction}"`);
assert.deepEqual(d.authority, { instruction: sent.instruction, budget: '70.00 USD', agent: 'Check shopper' });
assert.equal(d.purchase, null); assert.equal(d.dispute_id, null);
assert.deepEqual(d.decline, { reason: sent.reason, listings: LISTINGS });
assert.equal(d.events.length, 1);
assert.deepEqual([d.events[0].id, d.events[0].kind, d.events[0].mode, d.events[0].actor, d.events[0].at], [`decline:${ID}`, 'decline', 'recorded', 'shopping agent', sent.at]);
assert.ok(d.events[0].summary.includes(sent.reason) && d.events[0].summary.includes('3 listings'));
assert.ok(d.missing.some((m) => /no PayPal order, capture or dispute/.test(m)));
assert.ok(buildIncident(A)!.purchase); // purchases unchanged
console.log('incident: purchase null, authority, one RECORDED decline event, no order said as missing');

// Rendered: nothing undefined, no money-move counts, no capture "not recorded", no what-if.
const html = receiptPage(d, `https://desk.example/incident/${ID}`);
for (const bad of ['undefined', 'null', 'NaN', 'Money moves', 'Capture id', 'not recorded']) assert.ok(!html.includes(bad), `receipt shows ${bad}`);
assert.ok(html.includes('The agent bought nothing') && html.includes('WKD-02, costs $74') && html.includes('Rolltop dry duffel'));
assert.ok(html.includes('<th>Events on record</th><td>1, 2026-10-28</td>')); // one date, not "2026-10-28 to 2026-10-28"
assert.equal(whatIfPreset(d).none, NOTHING_BOUGHT);
assert.equal(reachedPayPal(d).text, 'Nothing in this incident reached PayPal.');
assert.ok(!/undefined/.test(notInRecords(d).text));
assert.throws(() => whatIf(`decline:${ID}`, { max_amount: 1 }), /No recorded request/);
assert.ok(page.includes(NOTHING_BOUGHT) && page.includes("$('#counts').hidden = $('#whatif-card').hidden = $('#q-whatif').hidden = !!d;"), 'the page no longer hides counts and the what-if for a decline');
console.log('render: receipt, questions and page say bought nothing; no counts, no what-if');

const { gate, loadPolicy } = await import('./gate.js');
const server = new McpServer({ name: 'check-decline', version: '0' });
addIncidentTools(server);
gate(server, loadPolicy());
const [x, y] = InMemoryTransport.createLinkedPair();
await server.connect(x);
const client = new Client({ name: 'check', version: '0' });
await client.connect(y);
const call = async (name: string, args: any) => { const r: any = await client.callTool({ name, arguments: args }); return { err: !!r.isError, body: JSON.parse(r.content[0].text) }; };
assert.ok((await call('junco_list_incidents', {})).body.some((i: any) => i.id === ID));
assert.deepEqual((await call('junco_get_incident', { id: ID })).body, JSON.parse(JSON.stringify(d)));
const wi: any = await client.callTool({ name: 'junco_what_if', arguments: { event_id: `decline:${ID}`, max_amount: 1 } });
assert.ok(wi.isError && /event_id/.test(wi.content[0].text)); // its input pattern takes hold: and gate: ids only
await client.close();
console.log('tools: listed, read in full, refused by the what-if');

assert.equal(fetches, 0);
console.log('decline: ok (0 network calls)');
