// BLACK BOX desk check, offline (no PayPal call, no desk): PayPal's refund id comes out of every shape a hold's result
// takes, events wear the right LIVE / RECORDED label, and the receipt carries the capture id, the incident id, what
// the records lack and a QR with the URL printed under it. The join and the what-if are check-incident's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptedText, modeOf, paypalRefund, receiptPage } from './incident-view.js';
import { NOTHING_PROPOSED, notInRecords, reachedPayPal, whatIfPreset } from './incident-questions.js';
import type { Incident, IncidentEvent } from './incident-types.js';

const refund = (result: string, method = 'create_refund') => paypalRefund({ method, result });
const paypal = JSON.stringify({ id: '1JU08902781691411', status: 'COMPLETED', links: [{ href: 'https://api.sandbox.paypal.com/v2/payments/refunds/1JU08902781691411', rel: 'self' }] });
assert.deepEqual(refund(paypal), { id: '1JU08902781691411', status: 'COMPLETED' }); // PayPal's own body
assert.deepEqual(refund(JSON.stringify({ content: [{ type: 'text', text: paypal }] })), { id: '1JU08902781691411', status: 'COMPLETED' }); // hosted MCP wrapper
assert.deepEqual(refund(JSON.stringify({ settled: 'a re-read shows the create_refund landed', was: paypal })), { id: '1JU08902781691411', status: 'COMPLETED' }); // settled later
assert.deepEqual(refund('Refund created. Refund id: 1JU08902781691411, status: PENDING'), { id: '1JU08902781691411', status: 'PENDING' }); // prose
assert.deepEqual(refund('{"id":"R1"}'), { id: 'R1', status: null });
assert.equal(refund(JSON.stringify({ error: { type: 'stale_hold', message: 'Not run: refunded' } })), null);
assert.equal(refund('{"ok":true}'), null);
assert.equal(refund(paypal, 'make_dispute_offer'), null); // only refunds carry a refund id
assert.equal(acceptedText({ method: 'create_refund', result: paypal }), 'PayPal made refund 1JU08902781691411, status COMPLETED');
assert.equal(acceptedText({ method: 'send_dispute_message', result: '{"ok":true}' }), 'PayPal accepted it');
console.log('refund id: read from PayPal JSON, the hosted wrapper, a settled hold and prose; errors and other actions give none');

// No mode here (cast): these test modeOf's own rule from kind and ref.rule. Once modeOf reads e.mode, give each its mode.
const ev = (id: string, kind: IncidentEvent['kind'], rule?: string) => ({ id, at: '2026-10-23T09:41:31.000Z', kind, actor: 'x', summary: 'the gate allowed it', source: 'x', ...(rule && { ref: { rule } }) }) as IncidentEvent;
const live = [ev('purchase:T1', 'purchase'), ev('payment:C1', 'payment'), ev('dispute:D1', 'dispute'), ev('dispute:D1:leased', 'dispute'), ev('webhook:h1', 'webhook'), ev('paypal:h1', 'paypal'),
  ev('gate:a', 'gate', 'allow: 5 is within the 25 limit for create_refund')];
const recorded = [ev('agent:a', 'agent'), ev('hold:h1', 'hold'), ev('approval:h1', 'approval'), ev('gate:b', 'gate', 'deny: denied by policy'), ev('gate:c', 'gate')] // the label reads ref.rule, never the summary;
assert.deepEqual(live.map(modeOf), live.map(() => 'live'));
assert.deepEqual(recorded.map(modeOf), recorded.map(() => 'recorded'));
console.log('labels: PayPal events and allowed gate calls LIVE; agent, hold, approval and denied gate calls RECORDED; never WHAT-IF');

const inc: Incident = {
  id: 'T1', title: '<script>x</script>', authority: { instruction: 'a dry bag under 40', budget: '40.00 USD', agent: 'shopping agent' },
  purchase: { sku: 'WKD-01', listing: 'WKD-01 Dry bag', reason: 'waterproof', amount: '34.00 USD', order_id: 'O1', capture_id: 'CAPTURE0001' },
  dispute_id: 'D1', events: [...live, ...recorded].map((e) => e.id === 'paypal:h1' ? { ...e, ref: { refund_id: 'REFUND0001' } } : e),
  counts: { proposed: 2, approved: 1, executed: 1, outcome_unknown: 0 }, missing: ['capture_id: this pool entry predates it'],
};
const url = 'https://desk.example/incident/T1';
const page = receiptPage(inc, url);
assert.ok(page.includes('CAPTURE0001') && page.includes('>T1<') && page.includes('REFUND0001') && page.includes('capture_id: this pool entry predates it'));
assert.ok(receiptPage({ ...inc, purchase: null }, url).includes('not recorded')); // an older entry without a capture id says so
assert.ok(page.includes('<td>WKD-01 Dry bag</td>') && !page.includes('WKD-01, WKD-01')); // the listing alone: it already starts with the SKU
assert.ok(page.includes('<svg') && page.includes(`<div class="u">${url}</div>`)); // QR, and the URL as text under it
assert.ok(!page.includes('<script>x') && page.includes('&#60;script&#62;x'));
console.log('receipt: capture id, incident id, refund id, what the records lack, a QR and the URL in text; titles escaped');
// The judge's three questions, from the incident JSON alone.
const asked = reachedPayPal(inc);
assert.deepEqual(asked.ids, live.map((e) => e.id)); // exactly the LIVE events, to highlight
assert.match(asked.text, /^7 of 12 events reached PayPal/);
assert.match(notInRecords(inc).text, /^1 thing is not in the records/);
assert.equal(notInRecords({ ...inc, missing: [] }).text, `Nothing missing. ${12 + 3 + 6 + 1} facts on record checked.`); // events, authority, purchase, dispute
const preset = whatIfPreset(inc);
assert.equal(preset.limit, 24); // 34.00 less 10
assert.deepEqual(preset.targets, ['gate:c', 'gate:b', 'hold:h1', 'gate:a']); // recorded money moves, newest first (same time: reverse order)
assert.equal(preset.none, null);
const quiet = whatIfPreset({ ...inc, purchase: { ...inc.purchase!, amount: '6.00' }, events: inc.events.filter((e) => e.kind !== 'gate' && e.kind !== 'hold') });
assert.deepEqual([quiet.limit, quiet.targets, quiet.none], [0, [], NOTHING_PROPOSED]); // never below 0; says how a move gets proposed
const pageJs = readFileSync('public/incident.html', 'utf8');
assert.ok(pageJs.includes(NOTHING_PROPOSED) && pageJs.includes('(amount - 10)') && pageJs.includes("/^allow:/")); // the page's plain-JS copy keeps step
console.log('questions: LIVE events highlighted, missing listed or counted, what-if preset at the amount less $10, nothing proposed said plainly');
console.log('incident-desk: ok');
