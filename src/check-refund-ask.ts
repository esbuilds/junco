// "Ask for your money back", offline, in a temp directory: a fake Claude (scripted replies) and a fake PayPal (a
// create_refund tool that counts calls, behind the real gate and policy.json; capture status from a table). Only the
// visitor's own agent buy may ask, once, within the caps and before Claude; the gate holds the refund and nothing reaches
// PayPal; the incident shows the ask, the hold and the AI's words; 24 hours undecided expires it lazily, and nothing then
// runs it (approve, the one-tap page, the gate's own resolve); other holds never expire.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const desk = readFileSync('src/desk.ts', 'utf8');
assert.ok(desk.includes("if (req.method === 'POST' && url.pathname === '/api/refund-ask')") && desk.includes('await askRefund(refundDeps, { session, owner,'), 'the desk no longer routes /api/refund-ask');
assert.ok(readFileSync('src/public.ts', 'utf8').indexOf('refund') < 0, 'the refund ask must stay behind the password');

// Fake Claude: each messages.create takes the next scripted reply.
let script: any[] = [], claudeCalls = 0;
const reply = (content: any[]) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, content, usage: { input_tokens: 500, output_tokens: 60 } });
const use = (name: string, input: any) => ({ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input });
const say = (text: string) => ({ type: 'text', text });
globalThis.fetch = (async (url: any) => {
  if (!String(url).includes('anthropic')) throw new Error(`check-refund-ask: no network (${url})`);
  claudeCalls++;
  const next = script.shift() ?? [say('(script ran out)')];
  return new Response(JSON.stringify(reply(next)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;
delete process.env.DATABASE_URL; delete process.env.REFUND_ASK_PER_DAY; delete process.env.REFUND_ASK_PER_SESSION;
process.env.ANTHROPIC_API_KEY = 'check';

const dir = mkdtempSync(join(tmpdir(), 'junco-refund-ask-'));
copyFileSync('policy.json', join(dir, 'policy.json'));
process.chdir(dir);
mkdirSync('.junco');
const A = 'a'.repeat(36), B = 'b'.repeat(36);
const rec = (sku: string, cap: string, instruction = 'a bag') => ({ instruction, budget: '70.00', sku, listing: `${sku} listing`, reason: 'fits', agent: 'Check shopper', capture_id: cap, paid_at: '2026-10-29T18:00:00.000Z' });
const buy = (cap: string, session: string, amount = '38.00') => ({ capture_id: cap, order_id: `ORD${cap}`, amount, session, added: '2026-10-29T18:00:01.000Z', agent: rec('WKD-03', cap) });
writeFileSync('.junco/agent-buys.json', JSON.stringify([buy('CAPA1', A), buy('CAPA2', A), buy('CAPA3', A), buy('CAPB1', B), buy('CAPDONE', A)]));
writeFileSync('.junco/pool.json', JSON.stringify([{ buyer_txn: 'POOLPOOLPOOLPOOL1', amount: '62.00', order_id: 'ORDPOOL', tracking: false, added: '2026-10-20T10:00:00.000Z', agent: rec('WKD-01', 'CAPPOOL') }]));

const { gate, loadPolicy, readHolds, requestApproval, EXPIRED_TEXT } = await import('./gate.js');
const { addIncidentTools, buildIncident } = await import('./incident.js');
const { askRefund, ASKER } = await import('./refund-ask.js');
const { actor, PUBLIC_SESSION } = await import('./store-dispute.js');
const { holdPage } = await import('./onetap.js');
const { holdNews } = await import('./holdcard.js');

// The desk's gated tools, as refundDeps builds them: the real gate in front, a create_refund that would reach PayPal.
const policy = loadPolicy();
assert.equal(policy.tools.create_refund, 'hold');
let paypalCalls = 0;
const tags: Record<string, string> = {};
const server = new McpServer({ name: 'check', version: '0' });
server.registerTool('create_refund', { description: 'Refund a capture', inputSchema: { capture_id: z.string(), amount: z.any().optional(), note_to_payer: z.string().optional() } },
  async () => { paypalCalls++; return { content: [{ type: 'text', text: '{"id":"REFUNDCHECK","status":"COMPLETED"}' }] }; });
addIncidentTools(server);
// The desk's onHold tags the hold in .junco/hold-tags.json (tagHold), where the incident reads who asked.
const g = gate(server, policy, (h) => { tags[h.id] = ASKER; writeFileSync('.junco/hold-tags.json', JSON.stringify(tags)); });
const [x, y] = InMemoryTransport.createLinkedPair();
await server.connect(x);
const client = new Client({ name: 'check', version: '0' });
await client.connect(y);
const status: Record<string, string> = { CAPA1: 'COMPLETED', CAPA2: 'COMPLETED', CAPA3: 'COMPLETED', CAPB1: 'COMPLETED', CAPDONE: 'REFUNDED' };
const deps = {
  policy: () => policy,
  captureStatus: async (id: string) => status[id] ?? 'unreadable',
  connect: async () => ({ tools: (await client.listTools()).tools as any[], close: async () => {},
    call: async (name: string, args: any) => String(((await client.callTool({ name, arguments: args })) as any).content[0].text) }),
};
const as = (session: string, owner = false) => ({ owner, session });
const ask = (who: { owner: boolean; session: string }, capture_id: string, reason = '') => actor.run(who, () => askRefund(deps, { ...who, capture_id, reason }));
const fails = (p: Promise<unknown>, code: number, re: RegExp) => assert.rejects(p, (e: any) => e.code === code && re.test(e.message));

// Who may ask: never the public, never another visitor's buy, never a pool purchase, never a payment that isn't COMPLETED.
await fails(ask(as(PUBLIC_SESSION), 'CAPA1'), 404, /Only a purchase your own shopping agent made/);
await fails(ask(as(B), 'CAPA1'), 403, /another visitor's/);
await fails(ask(as(A), 'CAPPOOL'), 404, /Only a purchase your own shopping agent made/);
await fails(ask(as(A), 'POOLPOOLPOOLPOOL1'), 404, /Only a purchase/);
await fails(ask(as(A), 'CAPDONE'), 409, /CAPDONE is REFUNDED on PayPal, not a completed payment/);
assert.equal(claudeCalls, 0);
console.log('who: the public, another visitor, a pool purchase and a refunded payment are refused before Claude');

// The ask: the agent reads the purchase, proposes create_refund, the gate holds it, nothing reaches PayPal.
script = [[use('junco_get_incident', { id: 'CAPA1' })], [use('create_refund', { capture_id: 'CAPA1' })], [say('I have asked the store owner to approve a full refund of $38.00.')]];
const t0 = Date.now();
const r1 = await ask(as(A), 'CAPA1', '  it   leaks  ');
assert.equal(r1.outcome, 'held'); assert.ok(r1.hold_id); assert.equal(r1.existing, false); assert.equal(r1.reason, 'it leaks');
assert.equal(paypalCalls, 0); assert.equal(claudeCalls, 3);
const h1 = readHolds().find((h) => h.id === r1.hold_id)!;
assert.deepEqual([h1.method, h1.args.capture_id, h1.status, tags[h1.id]], ['create_refund', 'CAPA1', 'pending', "a visitor's support agent (simulated buyer)"]);
const ttl = Date.parse(h1.expires!) - Date.parse(h1.created);
assert.ok(Math.abs(ttl - 24 * 3600_000) < 5000 && Date.parse(h1.created) >= t0 - 1000, `the hold expires 24 h after it was made (${ttl})`);
// The incident: the ask with the AI's words, then the gate's hold with its rule and its deadline.
const i1 = actor.run(as(A), () => buildIncident('CAPA1'))!;
const askEv = i1.events.find((e) => e.id.startsWith('ask:'))!, holdEv = i1.events.find((e) => e.id === `hold:${h1.id}`)!;
assert.match(askEv.summary, /^The visitor asked the support agent for a refund: "it leaks"\. It proposed create_refund; the gate held it for the owner as \w+\. The AI's own words: "I have asked the store owner/);
assert.equal(askEv.mode, 'recorded'); assert.equal(askEv.actor, 'support agent (Claude, for the visitor)');
assert.match(holdEv.summary, /^a visitor's support agent \(simulated buyer\) asked for create refund; the gate held it for the owner \(policy: create_refund = hold\)\. If the owner doesn't decide by .+ UTC, it expires and nothing moves\./);
assert.ok(i1.events.indexOf(askEv) < i1.events.indexOf(holdEv));
assert.deepEqual([i1.refund?.can_ask, i1.refund?.ask?.hold_status, i1.refund?.ask?.expires, i1.counts.proposed], [false, 'pending', h1.expires, 1]);
assert.equal(actor.run(as(A), () => buildIncident('CAPA2'))?.refund?.can_ask, true); // their other buy: may ask
assert.equal(actor.run(as(B), () => buildIncident('CAPA2'))?.refund?.can_ask, false); // not B's
assert.equal(actor.run(as('o', true), () => buildIncident('CAPA2'))?.refund?.can_ask, true); // the owner may
console.log('ask: read, proposed, held for the owner with 24 hours, tagged; nothing reached PayPal; the incident shows it all');
// The owner sees how much: this full refund (no amount, no payment snapshot here) takes the amount from the store's own
// records, the visitor's agent buy or a pool order, with no PayPal read (Oct 29: hold c600da3f's title had none).
const { holdAction, fullRefund } = await import('./onetap.js');
assert.equal(holdAction(h1), 'Full refund of $38.00 on payment CAPA1');
assert.ok(holdPage(h1, { e: '1', s: 'x' }, 'https://d').includes('<h1>Full refund of $38.00 on payment CAPA1</h1>'));
assert.equal(fullRefund({ method: 'create_refund', args: { capture_id: 'CAPPOOL' } }), 'Full refund of $62.00'); // a pool order
assert.equal(paypalCalls, 0);
console.log('amount: a full refund names how much from the store\'s records, on the one-tap page and its title');

// One per purchase: the second ask shows the first and its hold, with no Claude call.
const again = await ask(as(A), 'CAPA1', 'please');
assert.deepEqual([again.existing, again.hold_id, claudeCalls], [true, r1.hold_id, 3]);
// The agent tries more than was paid: refused here, never sent; it then proposes nothing. Recorded with its words.
script = [[use('create_refund', { capture_id: 'CAPA2', amount: { value: '999.00', currency_code: 'USD' } })], [use('create_refund', { capture_id: 'CAPB1' })], [say('I could not issue that refund.')]];
const r2 = await ask(as(A), 'CAPA2');
assert.equal(r2.outcome, 'no refund'); assert.equal(r2.hold_id, null); assert.match(r2.ai!, /^I could not issue that refund\. \[Refused here, not sent: a refund here can only name this purchase's capture\.\]$/);
assert.equal(paypalCalls, 0); assert.equal(readHolds().length, 1);
assert.match(actor.run(as(A), () => buildIncident('CAPA2'))!.events.find((e) => e.id.startsWith('ask:'))!.summary, /It proposed no refund\. The AI's own words: "I could not issue that refund/);
console.log('limits: one ask per purchase; a refund on another capture or over the price never leaves');

// Caps, before Claude: 2 asks per visitor a day (the owner skips it), 20 desk-wide, and the AI budget.
const n = claudeCalls;
await fails(ask(as(A), 'CAPA3'), 429, /your last refund ask today \(2 a visitor\)/);
process.env.REFUND_ASK_PER_DAY = '2';
await fails(ask(as('o', true), 'CAPA3'), 429, /had its runs for today/);
delete process.env.REFUND_ASK_PER_DAY;
writeFileSync('.junco/spend.json', JSON.stringify({ day: new Date().toISOString().slice(0, 10), usd: 0, calls: 0, stopped: 'check' }));
await fails(ask(as('o', true), 'CAPA3'), 503, /AI is paused/);
writeFileSync('.junco/spend.json', '{}');
assert.equal(claudeCalls, n);
console.log('caps: per visitor, desk-wide and the AI budget, all before Claude');

// 24 hours undecided: the next read marks it expired, and nothing will run it.
const pastDue = (id: string) => { const all = JSON.parse(readFileSync('.junco/holds.json', 'utf8')); all.find((h: any) => h.id === id).expires = new Date(Date.now() - 1000).toISOString(); writeFileSync('.junco/holds.json', JSON.stringify(all)); };
pastDue(h1.id);
await assert.rejects(g.approve(h1.id), /already expired/); // approve reads through the same store: expired first, then refused
const e1 = readHolds().find((h) => h.id === h1.id)!;
assert.equal(e1.status, 'expired'); assert.match(e1.result!, /didn't decide within 24 hours, so nothing moved/);
await assert.rejects(g.reject(h1.id), /already expired/);
assert.equal(paypalCalls, 0);
const page = holdPage(e1, { e: '1', s: 'x' }, 'https://d');
assert.ok(page.includes("This hold expired: the owner didn't decide within 24 hours, so nothing moved.") && !page.includes('<form')); // the one-tap page: no buttons
assert.match(holdNews(e1).text, /^Expired: the owner didn't decide within 24 hours, so nothing moved\.$/); // the connector's hold card
const i2 = actor.run(as(A), () => buildIncident('CAPA1'))!;
const exp = i2.events.find((x) => x.id === `approval:${h1.id}`)!;
assert.deepEqual([exp.summary, exp.at, exp.actor], [EXPIRED_TEXT, e1.expires, 'JUNCO (system)']);
assert.equal(i2.refund?.ask?.hold_status, 'expired'); assert.equal(i2.counts.approved, 0); assert.ok(!i2.missing.some((m) => m.includes(h1.id)));
// The gate's duplicate check doesn't join a new identical call to the expired hold, and doesn't refuse it as already run.
const dup: any = JSON.parse(((await client.callTool({ name: 'create_refund', arguments: { capture_id: 'CAPA1' } })) as any).content[0].text);
assert.equal(dup.held, true); assert.notEqual(dup.hold_id, h1.id); assert.equal(paypalCalls, 0);
console.log('expiry: lazily expired on read; approve, reject, the one-tap page and the hold card refuse it; the incident says nothing moved');

// Other holds never expire: no `expires`, however old.
const other = requestApproval('accept_dispute_claim', { dispute_id: 'PP-OLD' }, 'policy: accept_dispute_claim = hold');
const all = JSON.parse(readFileSync('.junco/holds.json', 'utf8'));
all.find((h: any) => h.id === other.id).created = new Date(Date.now() - 30 * 86_400_000).toISOString();
writeFileSync('.junco/holds.json', JSON.stringify(all));
assert.equal(readHolds().find((h) => h.id === other.id)?.status, 'pending');
assert.equal(readHolds().find((h) => h.id === dup.hold_id)?.status, 'pending'); // a hold made outside an ask has no expiry either
await client.close();
console.log('others: holds made any other way never expire');

// The AI's markdown, as plain text at display time (the stored words unchanged): Oct 29, incident 998856170L368615K
// showed "- **Listing wording:** ..." raw, run onto one line.
const { aiLines, aiText } = await import('./incident-questions.js');
const md = 'I can\'t approve it myself, but here is what I found:\n\n- **Listing wording:** The WKD-03 listing says "For light rain only."\n- **Your message:** `it leaks` in rain.\n\n__Next__: the owner decides.';
assert.deepEqual(aiLines(md), ["I can't approve it myself, but here is what I found:", 'Listing wording: The WKD-03 listing says "For light rain only."', 'Your message: it leaks in rain.', 'Next: the owner decides.']);
assert.deepEqual(aiLines('Found: - **A:** one - **B:** two'), ['Found:', 'A: one', 'B: two']); // a list run onto one line
assert.deepEqual(aiLines('It costs $38 - more than you said.'), ['It costs $38 - more than you said.']); // a plain dash stays
assert.equal(aiText('- **A:** one\n- **B:** two\n- done.'), 'A: one; B: two; done.');
const asks = JSON.parse(readFileSync('.junco/refund-asks.json', 'utf8'));
writeFileSync('.junco/refund-asks.json', JSON.stringify([...asks, { capture_id: 'CAPA3', session: A, at: new Date().toISOString(), reason: '', outcome: 'no refund', ai: md }]));
const rail = actor.run(as(A), () => buildIncident('CAPA3'))!.events.find((e) => e.id.startsWith('ask:'))!.summary;
assert.ok(!rail.includes('**') && !rail.includes('- **') && !rail.includes('`') && !rail.includes('__'), rail);
assert.match(rail, /The AI's own words: "I can't approve it myself, but here is what I found: Listing wording: The WKD-03 listing says "For light rain only\." Your message: it leaks in rain\. Next: the owner decides\."$/);
assert.equal(JSON.parse(readFileSync('.junco/refund-asks.json', 'utf8')).at(-1).ai, md); // stored as the AI wrote it
// The page and Studio use the same lines: the page's plain-JS copy matches the helper, and both draw a line per item.
const src = readFileSync(new URL('./incident-questions.ts', import.meta.url), 'utf8'), pageSrc = readFileSync(new URL('../public/incident.html', import.meta.url), 'utf8');
const body = (s: string) => s.match(/aiLines = \([^)]*\) => (s\.split[\s\S]*?filter\(Boolean\));/)?.[1].replace(/\s+/g, ' ');
assert.ok(body(src) && body(src) === body(pageSrc), 'public/incident.html no longer repeats aiLines');
assert.ok(pageSrc.includes("aiLines(a.ai).map(esc).join('<br>')"));
assert.ok(readFileSync(new URL('../studio/src/widgets/IncidentWidget.tsx', import.meta.url), 'utf8').includes('aiLines(r.ask.ai).map('));
console.log('words: the AI\'s markdown shows as plain lines on the rail, the card and Studio; the stored text is unchanged');
console.log('refund-ask: ok (Claude and PayPal faked, 0 real network calls)');
