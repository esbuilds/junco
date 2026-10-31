// "Approve it yourself", offline, in a temp directory: the real gate, hold store and policy.json with a fake PayPal (a
// create_refund tool that counts calls). The link decides one hold from "Ask for your money back" on the asking visitor's
// own purchase, once, while the hold lives, through the same re-checks, and it records as the demo approver, never the owner.
// Nothing else qualifies, the owner's one-tap link is exactly what it was, and neither link works as the other.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// The desk's wiring, read before leaving the repo: desk.ts can't be imported offline, it starts the server and timers.
const desk = readFileSync('src/desk.ts', 'utf8'), onetapSrc = readFileSync('src/onetap.ts', 'utf8'), demoSrc = readFileSync('src/demo-approver.ts', 'utf8'), incidentSrc = readFileSync('src/incident.ts', 'utf8');
const publicSrc = readFileSync('src/public.ts', 'utf8'), pageSrc = readFileSync('public/incident.html', 'utf8'), studioSrc = readFileSync('studio/src/widgets/IncidentWidget.tsx', 'utf8');

globalThis.fetch = (async (url: any) => { throw new Error(`check-demo-approver: no network (${url})`); }) as any;
delete process.env.DATABASE_URL; delete process.env.DEMO_APPROVE_PER_DAY;
const dir = mkdtempSync(join(tmpdir(), 'junco-demo-approver-'));
copyFileSync('policy.json', join(dir, 'policy.json'));
process.chdir(dir);
mkdirSync('.junco');
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((x) => x.repeat(36));
const rec = (cap: string) => ({ instruction: 'a bag', budget: '70.00', sku: 'WKD-03', listing: 'WKD-03 listing', reason: 'fits', agent: 'Check shopper', capture_id: cap, paid_at: '2026-10-29T18:00:00.000Z' });
const buy = (cap: string, session: string) => ({ capture_id: cap, order_id: `ORD${cap}`, amount: '38.00', session, added: '2026-10-29T18:00:01.000Z', agent: rec(cap) });
writeFileSync('.junco/agent-buys.json', JSON.stringify([buy('CAPA1', A), buy('CAPA2', A), buy('CAPB1', B), buy('CAPC1', C), buy('CAPC2', C), buy('CAPC3', C), buy('CAPD1', D), buy('CAPE1', E), buy('CAPE2', E), buy('CAPE3', E), buy('CAPE4', E), buy('CAPE5', E)]));

const { flagHolds, gate, gateRecord, loadPolicy, readHolds, requestApproval, setExpiry } = await import('./gate.js');
const { DEMO_APPROVER, PUBLIC_SESSION, actor, decidedBy, readDemoDecisions, saveRefundAsk } = await import('./store-dispute.js');
const { demoDecide, demoOffer, demoRefusal, demoRows, demoShow, demoTarget, DEMO_PATH, YOU_ARE } = await import('./demo-approver.js');
const { ASKER } = await import('./refund-ask.js');
const { buildIncident } = await import('./incident.js');
const { holdNews } = await import('./holdcard.js');
const { holdPage, linkRefusal, signedLink, LINK_MS } = await import('./onetap.js');
const { reconcile } = await import('./reconcile.js');
const { threeRecords } = await import('./incident-questions.js');
const { receiptPage } = await import('./incident-view.js');

const KEY = 'the-owner-token', BASE = 'https://d';
let paypalCalls = 0, seen: any = null;
const tags: Record<string, string> = {};
const tag = (id: string, who: string) => { tags[id] = who; writeFileSync('.junco/hold-tags.json', JSON.stringify(tags)); };
const server = new McpServer({ name: 'check', version: '0' });
server.registerTool('create_refund', { description: 'Refund a capture', inputSchema: { capture_id: z.string(), amount: z.any().optional() } },
  async () => { paypalCalls++; seen = actor.getStore(); return { content: [{ type: 'text', text: JSON.stringify({ id: `REFUND${paypalCalls}`, status: 'COMPLETED' }) }] }; });
const g = gate(server, loadPolicy(), (h: any) => tag(h.id, ASKER));
const [x, y] = InMemoryTransport.createLinkedPair();
await server.connect(x);
const client = new Client({ name: 'check', version: '0' });
await client.connect(y);

// A held refund ask, as askRefund leaves one: the gate's hold, tagged, with its 24 hours, and the ask naming it.
async function asked(capture_id: string, session: string) {
  const r = JSON.parse(((await client.callTool({ name: 'create_refund', arguments: { capture_id } })) as any).content[0].text);
  assert.equal(r.held, true);
  setExpiry(r.hold_id);
  saveRefundAsk({ capture_id, session, at: new Date().toISOString(), reason: '', outcome: 'held', hold_id: r.hold_id });
  return r.hold_id as string;
}
const deps = { key: () => KEY, desk: BASE, decide: (id: string, verb: 'approve' | 'reject', session: string) => actor.run({ owner: false, session }, () => g[verb](id)) };
const visitor = (session: string) => ({ owner: false, session });
const parts = (id: string, session = A) => { const u = new URL(demoOffer(KEY, BASE, id, visitor(session))!.url!); return { e: u.searchParams.get('e'), s: u.searchParams.get('s') }; };
const status = (id: string) => readHolds().find((h: any) => h.id === id)?.status;
const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);

// The offer: the visitor who asked, on their own held ask, and nobody else. The URL carries no session and no capture.
const h1 = await asked('CAPA1', A);
const offer = demoOffer(KEY, BASE, h1, visitor(A))!;
assert.ok(offer.url!.startsWith(`${BASE}${DEMO_PATH}/${h1}?e=`) && offer.qr!.startsWith('data:image/') && !offer.why);
assert.ok(!offer.url!.includes(A) && !offer.url!.includes('CAPA1'), 'a QR code must not carry the session or the capture');
assert.equal(new URL(offer.url!).searchParams.get('e'), String(Date.parse(readHolds().find((h) => h.id === h1)!.expires!)), 'it ends with the hold');
for (const v of [visitor(B), visitor(PUBLIC_SESSION), { owner: true, session: A }]) assert.equal(demoOffer(KEY, BASE, h1, v), undefined);
assert.equal(demoOffer(undefined, BASE, h1, visitor(A)), undefined, 'no key, no offer');
assert.equal(demoOffer(KEY, BASE, null, visitor(A)), undefined);
console.log('offer: only the visitor who asked, never the public, another visitor or the owner; the URL carries no session');

// GET only shows, however many times.
const q1 = parts(h1);
for (let i = 0; i < 3; i++) {
  const p = demoShow(deps, h1, q1);
  assert.equal(p.status, 200); assert.ok(p.html.includes(YOU_ARE.replace("'", '&#39;')) && p.html.includes('method="post"') && p.html.includes('Full refund of $38.00 on payment CAPA1'));
  assert.ok(p.html.includes('proves you hold it, not who you are') && p.html.includes(DEMO_APPROVER));
}
assert.deepEqual([status(h1), paypalCalls, readDemoDecisions().length], ['pending', 0, 0]);
console.log('GET: shows the hold and the words, decides nothing');

// Tampered links, and links carried to another hold.
const tamper: [string, string | null, string | null, RegExp][] = [
  [h1, q1.e, flip(q1.s!), /not valid/], [h1, String(Number(q1.e) + 1), q1.s, /not valid/], [h1, q1.e, `${q1.s}x`, /not valid/], [h1, q1.e, q1.s!.slice(0, -1), /not valid/],
  [h1, null, q1.s, /incomplete/], [h1, q1.e, null, /incomplete/], ['nosuchid', q1.e, q1.s, /not valid/],
];
for (const [id, e, s, re] of tamper) {
  assert.match(demoRefusal(KEY, id, e, s)!, re);
  const r = await demoDecide(deps, id, { e, s }, 'approve');
  assert.equal(r.status, 403); assert.ok(!r.html.includes('<form') && !r.html.includes('CAPA1'), 'a bad link learns nothing about the hold');
}
assert.match(demoRefusal('another-key', h1, q1.e, q1.s)!, /not valid/);
assert.match(demoRefusal(undefined, h1, q1.e, q1.s)!, /off/);
assert.deepEqual([status(h1), paypalCalls, readDemoDecisions().length], ['pending', 0, 0]);
const hB = await asked('CAPB1', B);
assert.match(demoRefusal(KEY, hB, q1.e, q1.s)!, /not valid/, "A's link on B's hold");
assert.equal((await demoDecide(deps, hB, q1, 'approve')).status, 403);
assert.equal(status(hB), 'pending');
console.log("tampered: a changed signature, expiry or hold, a wrong key, and another session's hold are all refused");

// Holds it must never reach, each with an ask or a tag trying to make it look right.
const notMine: [string, string][] = [];
const owner = requestApproval('create_refund', { capture_id: 'CAPC1' }, 'policy: create_refund = hold'); tag(owner.id, 'desk agent'); setExpiry(owner.id);
notMine.push([owner.id, 'a hold made by the owner\'s side, no ask']);
const disputeHold = requestApproval('accept_dispute_claim', { dispute_id: 'PP-1' }, 'policy'); tag(disputeHold.id, ASKER); setExpiry(disputeHold.id);
saveRefundAsk({ capture_id: 'CAPC1', session: C, at: '2026-10-30T00:00:01.000Z', reason: '', outcome: 'held', hold_id: disputeHold.id });
notMine.push([disputeHold.id, 'a dispute hold']);
const onDispute = requestApproval('create_refund', { capture_id: 'CAPC1', dispute_id: 'PP-2' }, 'policy'); tag(onDispute.id, ASKER); setExpiry(onDispute.id);
saveRefundAsk({ capture_id: 'CAPC1', session: C, at: '2026-10-30T00:00:02.000Z', reason: '', outcome: 'held', hold_id: onDispute.id });
notMine.push([onDispute.id, 'a refund naming a dispute']);
const whoElse = requestApproval('create_refund', { capture_id: 'CAPC2' }, 'policy'); tag(whoElse.id, 'Who else? run abc'); setExpiry(whoElse.id);
notMine.push([whoElse.id, 'a Who else? hold']);
const joined = requestApproval('create_refund', { capture_id: 'CAPC2' }, 'policy'); tag(joined.id, 'desk agent'); setExpiry(joined.id);
saveRefundAsk({ capture_id: 'CAPC2', session: C, at: '2026-10-30T00:00:03.000Z', reason: '', outcome: 'held', hold_id: joined.id });
notMine.push([joined.id, 'someone else\'s hold an ask joined']);
const noExpiry = requestApproval('create_refund', { capture_id: 'CAPC3' }, 'policy'); tag(noExpiry.id, ASKER);
saveRefundAsk({ capture_id: 'CAPC3', session: C, at: '2026-10-30T00:00:04.000Z', reason: '', outcome: 'held', hold_id: noExpiry.id });
notMine.push([noExpiry.id, 'a hold without the ask\'s 24 hours']);
const tooMuch = requestApproval('create_refund', { capture_id: 'CAPC3', amount: { value: '999.00', currency_code: 'USD' } }, 'policy'); tag(tooMuch.id, ASKER); setExpiry(tooMuch.id);
saveRefundAsk({ capture_id: 'CAPC3', session: C, at: '2026-10-30T00:00:05.000Z', reason: '', outcome: 'held', hold_id: tooMuch.id });
notMine.push([tooMuch.id, 'a refund over the price']);
const byOwner = requestApproval('create_refund', { capture_id: 'CAPD1' }, 'policy'); tag(byOwner.id, ASKER); setExpiry(byOwner.id);
saveRefundAsk({ capture_id: 'CAPD1', session: 'an-owner-session', at: '2026-10-30T00:00:06.000Z', reason: '', outcome: 'held', hold_id: byOwner.id });
notMine.push([byOwner.id, "the owner's ask on a visitor's purchase"]);
for (const [id, what] of notMine) {
  assert.equal(demoTarget(id), null, what);
  for (const v of [visitor(C), visitor(D), visitor('an-owner-session')]) assert.equal(demoOffer(KEY, BASE, id, v), undefined, what);
  assert.match(demoRefusal(KEY, id, q1.e, q1.s)!, /not valid/, what);
  assert.equal((await demoDecide(deps, id, q1, 'approve')).status, 403, what);
  assert.equal(status(id), 'pending', what);
}
assert.equal(paypalCalls, 0);
console.log(`never: ${notMine.map(([, w]) => w).join('; ')}`);

// One capability never works as the other, and the owner's link is what it was.
const ownerUrl = new URL(signedLink(BASE, KEY, h1, 1000));
const [oe, os] = [ownerUrl.searchParams.get('e')!, ownerUrl.searchParams.get('s')!];
assert.equal(os, createHmac('sha256', KEY).update(`junco-hold:${h1}:${1000 + 48 * 3600_000}`).digest('base64url').slice(0, 32), "the owner's signature changed");
assert.equal(LINK_MS, 48 * 3600_000);
assert.equal(linkRefusal(KEY, h1, oe, os, 2000), null);
assert.match(demoRefusal(KEY, h1, oe, os)!, /not valid/, "an owner link can't be used here");
assert.match(linkRefusal(KEY, h1, q1.e, q1.s)!, /not valid/, "a demo link can't be used as the owner's");
assert.equal((await demoDecide(deps, h1, { e: oe, s: os }, 'approve')).status, 403);
const ownerPage = holdPage(readHolds().find((h: any) => h.id === h1), { e: oe, s: os }, BASE);
assert.ok(ownerPage.includes('a hold for you') && ownerPage.includes('Held for you.') && !/demo/i.test(ownerPage));
assert.ok(!/demo/i.test(onetapSrc), "the owner's one-tap code doesn't know the demo approver");
assert.ok(desk.includes("actor.run({ owner: true, session: 'one-tap' }, () => decideHold(id, verb, 'the owner (one-tap link)'))"), "the owner's one-tap route changed");
assert.ok(desk.includes("const why = linkRefusal(process.env.OWNER_TOKEN, id, q.e, q.s);"), "the owner's one-tap check changed");
assert.equal(status(h1), 'pending');
console.log("one-tap: the owner's signature, page and route are as before, and neither link works as the other");

// A cap refusal spends nothing: the hold stays the owner's to decide, and the visitor's link still works tomorrow.
process.env.DEMO_APPROVE_PER_DAY = '0';
const capped = await demoDecide(deps, h1, q1, 'approve');
assert.equal(capped.status, 429); assert.match(capped.html, /had its demo approvals for today/);
assert.deepEqual([status(h1), paypalCalls, readDemoDecisions().length], ['pending', 0, 0]);
const off = demoOffer(KEY, BASE, h1, visitor(A))!;
assert.deepEqual([off.url, off.qr], [null, null]); assert.match(off.why!, /had its demo approvals/);
delete process.env.DEMO_APPROVE_PER_DAY;

// A second purchase's link, minted while this visitor still has their one approval: the cap has to hold at the POST too.
const hA2 = await asked('CAPA2', A), qA2 = parts(hA2);

// Approve: through the gate, as the visitor, never the owner, and PayPal's refund id comes back to the phone.
const done = await demoDecide(deps, h1, q1, 'approve');
assert.equal(done.status, 200); assert.ok(done.html.includes('Approved. PayPal made refund REFUND1, status COMPLETED.'));
assert.ok(!done.html.includes('<form'));
assert.deepEqual([status(h1), paypalCalls], ['completed', 1]);
assert.deepEqual(seen, visitor(A), 'it ran as the visitor who asked');
assert.deepEqual(readDemoDecisions().map((d: any) => [d.hold_id, d.capture_id, d.session, d.verb]), [[h1, 'CAPA1', A, 'approve']]);
assert.ok(done.html.includes(`${BASE}/incident/CAPA1`));
console.log("approve: runs once through the gate as that visitor, and the phone shows PayPal's refund id");

// A used link: refused on POST, either verb, and GET says so with no buttons.
for (const verb of ['approve', 'reject'] as const) { const r = await demoDecide(deps, h1, q1, verb); assert.equal(r.status, 409); assert.match(r.html, /This link has been used/); assert.ok(!r.html.includes('<form')); }
const shown = demoShow(deps, h1, q1);
assert.ok(shown.html.includes('This link has been used.') && !shown.html.includes('<form'));
assert.equal(demoOffer(KEY, BASE, h1, visitor(A)), undefined, 'no offer once it is spent');
assert.deepEqual([paypalCalls, readDemoDecisions().length], [1, 1]);
console.log('used: a second tap is refused and nothing reaches PayPal');

// A double tap on the phone: the claim comes before any await, so one runs.
const hE = await asked('CAPE1', E), qE = parts(hE, E);
const both = await Promise.all([demoDecide(deps, hE, qE, 'approve'), demoDecide(deps, hE, qE, 'approve')]);
assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
assert.equal(paypalCalls, 2);
console.log('double tap: two at once make one refund');

// Caps, before PayPal: one approval per visitor a day; a rejection isn't one, and the link it spends is spent.
const noMore = demoOffer(KEY, BASE, hA2, visitor(A))!;
assert.equal(noMore.url, null); assert.match(noMore.why!, /your demo approval for today \(1 a visitor\)/);
const second = await demoDecide(deps, hA2, qA2, 'approve');
assert.equal(second.status, 429); assert.match(second.html, /your demo approval for today/);
assert.deepEqual([status(hA2), paypalCalls, readDemoDecisions().some((d) => d.hold_id === hA2)], ['pending', 2, false], 'refused before PayPal, and nothing spent');
const hE2 = await asked('CAPE2', E);
assert.equal(demoOffer(KEY, BASE, hE2, visitor(E))?.url, null);
assert.equal(paypalCalls, 2);
console.log('caps: one approval a visitor, a low total for the desk, both before PayPal');

// A reject decides, sends nothing, and is recorded as the visitor's.
const qB = parts(hB, B);
const rejected = await demoDecide(deps, hB, qB, 'reject');
assert.equal(rejected.status, 200); assert.ok(rejected.html.includes('Rejected. Nothing was sent to PayPal.'));
assert.deepEqual([status(hB), paypalCalls], ['rejected', 2]);
assert.equal((await demoDecide(deps, hB, qB, 'approve')).status, 409);
console.log('reject: nothing sent, and the link is spent');

// The same re-checks: a refund PayPal reported after the hold makes the gate refuse it, and nothing runs.
const F = 'f'.repeat(36), buys2 = [...JSON.parse(readFileSync('.junco/agent-buys.json', 'utf8')), buy('CAPF1', F)];
writeFileSync('.junco/agent-buys.json', JSON.stringify(buys2));
const hR = await asked('CAPF1', F), qR = parts(hR, F);
flagHolds({ capture_id: 'CAPF1' }, 'PAYMENT.CAPTURE.REFUNDED', new Date(Date.now() + 1000).toISOString(), { id: 'OUTSIDE1', at: new Date(Date.now() + 1000).toISOString() });
const refused = await demoDecide(deps, hR, qR, 'approve');
assert.equal(refused.status, 409); assert.match(refused.html, /PayPal reported refund OUTSIDE1/);
assert.equal(paypalCalls, 2); assert.equal(status(hR), 'stale');
assert.equal(readDemoDecisions().filter((d: any) => d.hold_id === hR).length, 1, 'a refused approval still spent the link');
console.log('re-checks: the gate refuses a refund PayPal already reported, as it does for the owner');

// Expiring with the hold: past its time the link is dead, and a lapsed hold decides nothing.
const G = 'g'.repeat(36);
writeFileSync('.junco/agent-buys.json', JSON.stringify([...buys2, buy('CAPG1', G), buy('CAPG2', G)]));
const hX = await asked('CAPG1', G), qX = parts(hX, G), exp = Number(qX.e);
assert.match(demoRefusal(KEY, hX, qX.e, qX.s, exp + 1)!, /expired/);
assert.equal((await demoDecide(deps, hX, qX, 'approve', exp + 1)).status, 403);
assert.equal(demoShow(deps, hX, qX, exp + 1).status, 403);
assert.equal(status(hX), 'pending');
const stored = JSON.parse(readFileSync('.junco/holds.json', 'utf8'));
stored.find((h: any) => h.id === hX).status = 'expired'; // what the lazy lapse leaves, with its expires unchanged
writeFileSync('.junco/holds.json', JSON.stringify(stored));
const lapsed = await demoDecide(deps, hX, qX, 'approve');
assert.equal(lapsed.status, 409); assert.match(lapsed.html, /This hold expired/); assert.ok(!lapsed.html.includes('<form'));
assert.equal(paypalCalls, 2);
const hY = await asked('CAPG2', G), qY = parts(hY, G);
const past = JSON.parse(readFileSync('.junco/holds.json', 'utf8'));
past.find((h: any) => h.id === hY).expires = new Date(Date.now() - 1000).toISOString();
writeFileSync('.junco/holds.json', JSON.stringify(past));
assert.equal((await demoDecide(deps, hY, qY, 'approve')).status, 403);
assert.equal(status(hY), 'expired'); assert.equal(paypalCalls, 2);
console.log('expiry: the link ends with the hold, and an expired hold never runs');

// How it records: the demo approver on every record, never the owner, and the owner's own decisions read as before.
const inc = actor.run(visitor(A), () => buildIncident('CAPA1'))!;
const ev = inc.events.find((e: any) => e.id === `approval:${h1}`)!;
assert.deepEqual([ev.actor, ev.summary], ['demo approver (a desk visitor)', 'The demo approver (a desk visitor) approved create refund.']);
assert.deepEqual(inc.counts, { proposed: 1, approved: 0, executed: 1, outcome_unknown: 0, demo_approved: 1 });
assert.equal(inc.refund?.ask?.decided_by, DEMO_APPROVER);
assert.ok(!JSON.stringify(inc.events.filter((e: any) => e.id === `approval:${h1}`)).toLowerCase().includes('owner'));
const gateColumn = threeRecords(inc)!.columns.find((c: any) => c.title === 'What the gate recorded')!;
assert.deepEqual(gateColumn.rows.slice(0, 4), [{ label: 'Proposed', value: '1' }, { label: 'Approved', value: '0' }, { label: 'Approved by the demo approver', value: '1' }, { label: 'Executed', value: '1' }]);
assert.ok(receiptPage(inc, 'https://d/x').includes('1 approved by the demo approver'));
const rejectedInc = actor.run(visitor(B), () => buildIncident('CAPB1'))!;
assert.equal(rejectedInc.events.find((e: any) => e.id === `approval:${hB}`)!.summary, 'The demo approver (a desk visitor) rejected it; nothing was sent to PayPal (time not recorded).');
assert.equal(holdNews(readHolds().find((h: any) => h.id === h1)).text, 'Approved by the demo approver (a desk visitor), and PayPal accepted it.');
assert.equal(holdNews(readHolds().find((h: any) => h.id === hB)).text, 'Rejected by the demo approver (a desk visitor). Nothing was sent to PayPal.');
const API = 'https://api.sandbox.paypal.com', pp = { status: 'REFUNDED', links: [{ rel: 'up', href: `${API}/v2/checkout/orders/ORDCAPA1` }] };
const order = { purchase_units: [{ payments: { refunds: [{ id: 'REFUND1', status: 'COMPLETED', amount: { value: '38.00', currency_code: 'USD' }, links: [{ rel: 'up', href: `${API}/v2/payments/captures/CAPA1` }] }] } }] };
const lines = await reconcile('CAPA1', readHolds().filter((h: any) => h.id === h1), async (p: string) => ({ status: 200, body: p.includes('captures') ? pp : order }), [], decidedBy);
assert.ok(incidentSrc.includes('readMoves().filter((m) => mine(m.args)), decidedBy)'), 'the incident page must pass who decided');
assert.ok(lines.some((l: any) => l.summary.includes(`hold ${h1}, approved by the demo approver (a desk visitor).`)), 'reconciliation names who approved');
const rows = gateRecord(readHolds(), [], [], (h: any) => tags[h.id]);
const view = demoRows(rows), row = (id: string) => view.find((r: any) => r.hold_id === id)!;
assert.equal(rows.find((r: any) => r.hold_id === h1)!.outcome, 'approved by the owner, PayPal accepted it', "gate.ts's own words, which the desk relabels");
assert.equal(row(h1).outcome, 'approved by the demo approver (a desk visitor), PayPal accepted it');
assert.equal(row(hB).outcome, 'rejected by the demo approver (a desk visitor), nothing sent');
console.log('records: incident, counts, three records, receipt, hold card, reconciliation and the Gate record all say the demo approver');

// An owner decision is untouched by any of it: no record of a visitor, so it reads as the owner's.
const ownerHold = requestApproval('create_refund', { capture_id: 'CAPG2', amount: { value: '1.00', currency_code: 'USD' } }, 'policy'); tag(ownerHold.id, 'desk agent');
await g.approve(ownerHold.id);
const oRow = demoRows(gateRecord(readHolds(), [], [], (h: any) => tags[h.id])).find((r: any) => r.hold_id === ownerHold.id)!;
assert.equal(oRow.outcome, 'approved by the owner, PayPal accepted it');
assert.equal(holdNews(readHolds().find((h: any) => h.id === ownerHold.id)).text, 'Approved by the owner, and PayPal accepted it.');
const incG = actor.run(visitor(G), () => buildIncident('CAPG2'))!;
assert.equal(incG.events.find((e: any) => e.id === `approval:${ownerHold.id}`)!.actor, 'owner');
assert.equal(incG.counts.approved, 1); assert.equal(incG.counts.demo_approved, undefined);
await client.close();
console.log("owner: the owner's own decisions read exactly as before");

// The desk's wiring: before the password like the owner's link, GET can't decide, it never runs as the owner, and the words match.
const at = (s: string) => { const i = desk.indexOf(s); assert.ok(i >= 0, `desk.ts no longer has: ${s}`); return i; };
assert.ok(at("req.url?.match(/^\\/demo-approve\\/([\\w-]+)(?:\\?|$)/)") < at('if (await oauth(req, res, DESK_URL'), 'the link opens with no password, like the one-tap');
at("verb === 'approve' || verb === 'reject' ? await demoDecide(demoDeps, id, q, verb) : demoShow(demoDeps, id, q)");
at("const form = req.method === 'POST' ? new URLSearchParams(await readRaw(req, 10_000)) : null, verb = form?.get('verb');");
at("decide: (id, verb, session) => actor.run({ owner: false, session }, () => decideHold(id, verb, DEMO_APPROVER))");
at('const rows = demoRows(gateRecord(');
at('notifyDecision(h, `${done}.`);');
at("demo ? 'demo approver' : 'owner'");
at('demoOffer(process.env.OWNER_TOKEN, DESK_URL, r.refund.ask?.hold_id, actor.getStore()!)');
assert.ok(desk.includes('`approved by ${who}, and ${acceptedText(h)}`'), "Slack's line must take who decided");
assert.ok(!/demo/i.test(publicSrc), 'the link needs no public route; it carries its own signature');
assert.ok(!/from '\.\/demo-approver/.test(incidentSrc), "the link stays out of buildIncident, so a connector or a model never sees it");
assert.ok(!/claude\(|\.messages\.create|paypal\(|fetch\(/.test(demoSrc), 'no model call and no PayPal call of its own');
for (const [name, src] of [['public/incident.html', pageSrc], ['IncidentWidget.tsx', studioSrc]] as const) {
  assert.ok(src.includes(YOU_ARE), `${name} words it differently`);
  assert.match(src, /proves you hold the link, not who you are/, `${name} must not imply the link proves who they are`);
}
console.log('wiring: the route is before the password, GET only shows, it never runs as the owner, the link stays out of connectors');
console.log('demo-approver: ok (PayPal faked, 0 real network calls)');
