// BLACK BOX desk check, offline (no PayPal call, no desk): PayPal's refund id comes out of every shape a hold's result
// takes, events wear the right LIVE / RECORDED label, the what-if never counts a PayPal call, and the receipt carries
// the capture id, the incident id and a QR with the URL printed under it.
import assert from 'node:assert/strict';
import { acceptedText, FIXTURE, modeOf, paypalRefund, receiptPage, whatIf } from './incident-view.js';

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

const modes = Object.fromEntries(FIXTURE.events.map((e) => [e.kind, modeOf(e)]));
assert.deepEqual([modes.purchase, modes.payment, modes.dispute, modes.webhook, modes.paypal], ['live', 'live', 'live', 'live', 'live']);
assert.deepEqual([modes.agent, modes.gate, modes.hold, modes.approval], ['recorded', 'recorded', 'recorded', 'recorded']);
assert.ok(FIXTURE.events.every((e) => modeOf(e) !== 'what-if')); // what-if only ever comes from whatIf()
const gateEvent = FIXTURE.events.find((e) => e.kind === 'gate')!.id;
const [low, high] = [await whatIf(gateEvent, { refund_limit: 30 }), await whatIf(gateEvent, { refund_limit: 50 })];
assert.deepEqual([low.mode, low.paypal_calls, low.after.verdict, high.after.verdict], ['what-if', 0, 'hold', 'allow']);
console.log('labels: PayPal events LIVE, desk records RECORDED, what-if never in the record and zero PayPal calls');

const url = `https://desk.example/incident/${FIXTURE.id}`;
const page = receiptPage({ ...FIXTURE, title: '<script>x</script>' }, url);
assert.ok(page.includes(FIXTURE.purchase!.capture_id!) && page.includes(FIXTURE.id) && page.includes('FIXTURE0REFUND01'));
assert.ok(page.includes('<svg') && page.includes(`<div class="u">${url}</div>`)); // QR, and the URL as text under it
assert.ok(!page.includes('<script>x') && page.includes('&#60;script&#62;x'));
console.log('receipt: capture id, incident id, refund id, a QR and the URL in text; titles escaped');
console.log('incident-desk: ok');
