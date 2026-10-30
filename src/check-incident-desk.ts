// BLACK BOX desk check, offline (no PayPal call, no desk): PayPal's refund id comes out of every shape a hold's result
// takes, events wear the right LIVE / RECORDED label, and the receipt carries the capture id, the incident id, what
// the records lack and a QR with the URL printed under it. The join and the what-if are check-incident's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptedText, modeOf, paypalRefund, receiptPage } from './incident-view.js';
import { NOTHING_PROPOSED, notInRecords, reachedPayPal, threeRecords, whatIfPreset } from './incident-questions.js';
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

const ev = (id: string, kind: IncidentEvent['kind'], mode: IncidentEvent['mode'], rule?: string): IncidentEvent => ({ id, at: '2026-10-23T09:41:31.000Z', kind, mode, actor: 'x', summary: 'the gate allowed it', source: 'x', ...(rule && { ref: { rule } }) });
const live = [ev('purchase:T1', 'purchase', 'live'), ev('payment:C1', 'payment', 'live'), ev('dispute:D1', 'dispute', 'live'), ev('webhook:h1', 'webhook', 'live'), ev('paypal:h1', 'paypal', 'live'),
  ev('gate:a', 'gate', 'live', 'allow: 5 is within the 25 limit for create_refund')];
const recorded = [ev('agent:a', 'agent', 'recorded'), ev('hold:h1', 'hold', 'recorded'), ev('approval:h1', 'approval', 'recorded'), ev('gate:b', 'gate', 'recorded', 'deny: denied by policy'), ev('gate:c', 'gate', 'recorded'), ev('dispute:D1:leased', 'dispute', 'recorded')];
assert.deepEqual(live.map(modeOf), live.map(() => 'live'));
assert.deepEqual(recorded.map(modeOf), recorded.map(() => 'recorded'));
assert.equal(modeOf({ ...live[0], mode: 'recorded' }), 'recorded'); // the event's own mode wins over the rule
const bare = (e: IncidentEvent) => { const { mode: _, ...rest } = e; return rest as IncidentEvent; }; // events from before mode existed
assert.deepEqual([...live, ...recorded].map(bare).map(modeOf), [...live, ...recorded].map((e) => e.mode)); // the fallback rule agrees, lease included
console.log('labels: the event\'s own mode wins; without one, PayPal events and allowed gate calls LIVE, desk decisions and leases RECORDED');

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
// Same product as the desk: Graphite and Geist on screen, plain black on white in print, the old cream lines gone.
assert.ok(page.includes('family=Geist') && page.includes('#18181b') && !page.includes('#e3e0d8') && !/font:[^;}]*Inter/.test(page));
assert.ok(/@media print\{.*color:#000/.test(page));
console.log('receipt: capture id, incident id, refund id, what the records lack, a QR and the URL in text; titles escaped');
// The judge's three questions, from the incident JSON alone.
const asked = reachedPayPal(inc);
assert.deepEqual(asked.ids, live.map((e) => e.id)); // exactly the LIVE events, to highlight
assert.match(asked.text, /^6 of 12 events reached PayPal/);
assert.match(notInRecords(inc).text, /^1 thing is not in the records/);
assert.equal(notInRecords({ ...inc, missing: [] }).text, `Nothing missing. ${12 + 3 + 6 + 1} facts on record checked.`); // events, authority, purchase, dispute
const preset = whatIfPreset(inc);
assert.equal(preset.limit, 24); // 34.00 less 10
assert.deepEqual(preset.targets, ['gate:c', 'gate:b', 'hold:h1', 'gate:a']); // recorded money moves, newest first (same time: reverse order)
assert.equal(preset.none, null);
const quiet = whatIfPreset({ ...inc, purchase: { ...inc.purchase!, amount: '6.00' }, events: inc.events.filter((e) => e.kind !== 'gate' && e.kind !== 'hold') });
assert.deepEqual([quiet.limit, quiet.targets, quiet.none], [0, [], NOTHING_PROPOSED]); // never below 0; says how a move gets proposed
const pageJs = readFileSync('public/incident.html', 'utf8');
assert.ok(pageJs.includes(NOTHING_PROPOSED) && pageJs.includes('(amount - 10)') && pageJs.includes('const modeOf = (e) => e.mode ?? (') && pageJs.includes("/^allow:/") && pageJs.includes("!e.id.endsWith(':leased')")); // the page's plain-JS copy keeps step
console.log('questions: LIVE events highlighted, missing listed or counted, what-if preset at the amount less $10, nothing proposed said plainly');

// Three records: one purchase side by side, from the incident alone. Summaries as reconcile.ts writes them for real payments.
const line = (id: string, summary: string, match?: IncidentEvent['match'], mode: IncidentEvent['mode'] = 'live'): IncidentEvent =>
  ({ id: `reconciliation:${id}`, at: '2026-10-30T12:51:07.657Z', kind: 'reconciliation', mode, actor: 'JUNCO (system)', source: 'PayPal', summary, ...(match && { match }) });
const OUTSIDE = 'PayPal shows a refund of 1.37 USD (2V173278FH578534S, COMPLETED) that the desk has no record of.';
const read = (n: string, status: string) => line('read', `PayPal shows ${n} on this payment, and lists the payment as ${status}.`);
const shape = (over: Partial<Incident>): Incident => ({ ...inc, dispute_id: null, missing: [], counts: { proposed: 0, approved: 0, executed: 0, outcome_unknown: 0 }, events: [], ...over });
const col = (r: ReturnType<typeof threeRecords>, i: number, label: string) => r!.columns[i].rows.filter((x) => x.label === label).map((x) => x.value);

const outside = threeRecords(shape({ events: [
  { id: 'outside_refund:2V173278FH578534S', at: '2026-10-30T12:47:05.000Z', kind: 'outside_refund', mode: 'live', actor: 'PayPal', source: 'webhook', summary: "PayPal reported a refund of 1.37 USD (2V173278FH578534S) the desk didn't make." },
  read('1 refund', 'PARTIALLY_REFUNDED'), line('2V173278FH578534S', OUTSIDE, 'paypal_only')] }))!;
assert.equal(outside.agree, false);
assert.equal(outside.line, `The records differ. ${OUTSIDE}`);
assert.deepEqual(outside.columns.map((c) => [c.title, c.mode]), [['What the AI believed', 'recorded'], ['What the gate recorded', 'recorded'], ['What PayPal says', 'live']]);
assert.deepEqual(outside.columns[0].rows.map((r) => [r.label, r.value]), [['Asked', 'a dry bag under 40'], ['Budget', '40.00 USD'], ['Bought', 'WKD-01 for 34.00 USD'], ['Its reason', 'waterproof']]);
assert.deepEqual(col(outside, 1, 'Proposed'), ['0']);
assert.deepEqual(col(outside, 1, 'Holds'), ['None']);
assert.deepEqual(col(outside, 2, 'Refund'), [OUTSIDE]);
assert.deepEqual(col(outside, 2, 'Webhook'), ["PayPal reported a refund of 1.37 USD (2V173278FH578534S) the desk didn't make."]);
assert.deepEqual(col(outside, 2, 'Fingerprint'), ['Not recorded at PayPal (placed before fingerprints).']);

const HOLD = "PayPal's record reads as a dispute hold of 59.35 USD: entry 6E9082945T161501K is PENDING on a payment held for a buyer complaint, and PayPal records 0.00 USD refunded, so no money has gone back to the buyer. The desk has nothing to match here.";
const held = threeRecords(shape({ dispute_id: 'PP-R-COU-10194957', events: [read('no refunds', 'PENDING: BUYER_COMPLAINT'), line('6E9082945T161501K', HOLD, 'dispute_hold')] }))!;
assert.equal(held.agree, true, 'a dispute hold is not a difference');
assert.equal(held.line, "The three records agree. PayPal's dispute hold on this payment isn't a difference: no money has gone back.");
assert.deepEqual(col(held, 2, 'Dispute hold'), [HOLD]);

const made = threeRecords(shape({ counts: { proposed: 1, approved: 1, executed: 1, outcome_unknown: 0 }, events: [
  { id: 'hold:04d179a8', at: '2026-10-28T16:09:30.941Z', kind: 'hold', mode: 'recorded', actor: 'MCP client', source: 'holds', summary: 'MCP client asked for create refund of 10.00 USD.', ref: { hold_id: '04d179a8' } },
  { id: 'approval:04d179a8', at: '2026-10-28T16:11:39.252Z', kind: 'approval', mode: 'recorded', actor: 'owner', source: 'holds', summary: 'The owner approved create refund of 10.00 USD.', ref: { hold_id: '04d179a8' } },
  { id: 'paypal:04d179a8', at: '2026-10-28T16:11:39.252Z', kind: 'paypal', mode: 'live', actor: 'PayPal', source: 'holds', summary: 'PayPal created refund 8EV94782FY6329802 (COMPLETED).', ref: { hold_id: '04d179a8', refund_id: '8EV94782FY6329802' } },
  { id: 'hold:853278a7', at: '2026-10-28T16:07:35.915Z', kind: 'hold', mode: 'recorded', actor: 'MCP client', source: 'holds', summary: 'MCP client asked for create refund of 10.00 USD.', ref: { hold_id: '853278a7' } },
  { id: 'approval:853278a7', at: '2026-10-28T16:07:35.915Z', kind: 'approval', mode: 'recorded', actor: 'owner', source: 'holds', summary: 'The owner rejected it; nothing was sent to PayPal (time not recorded).', ref: { hold_id: '853278a7' } },
  { id: 'hold:waiting1', at: '2026-10-28T16:07:35.915Z', kind: 'hold', mode: 'recorded', actor: 'MCP client', source: 'holds', summary: 'MCP client asked for create refund of 2.00 USD.', ref: { hold_id: 'waiting1' } },
  read('1 refund', 'PARTIALLY_REFUNDED'), line('8EV94782FY6329802', 'PayPal shows refund 8EV94782FY6329802 for 10.00 USD (COMPLETED). The desk made it: hold 04d179a8, approved by the owner.', 'matched')] }))!;
assert.equal(made.agree, true);
assert.equal(made.line, 'The three records agree.');
assert.deepEqual(col(made, 1, 'Holds'), []);
assert.deepEqual([col(made, 1, 'Hold 04d179a8'), col(made, 1, 'Hold 853278a7'), col(made, 1, 'Hold waiting1')],
  [['PayPal created refund 8EV94782FY6329802 (COMPLETED).'], ['The owner rejected it; nothing was sent to PayPal (time not recorded).'], ['Waiting for the owner.']]);

const down = line('read', "PayPal didn't answer (socket hang up), so the refunds on this payment were not checked against the desk.", 'unread', 'recorded');
const unread = threeRecords(shape({ events: [down] }))!;
assert.equal(unread.agree, null, 'nothing read is never an agreement');
assert.equal(unread.line, "PayPal didn't answer, so the three records can't be compared right now.");
assert.equal(unread.columns[2].mode, 'recorded');
assert.deepEqual(col(unread, 2, 'Payment'), [down.summary]);
const noRead = threeRecords(shape({ events: [] }))!;
assert.equal(noRead.agree, null);
assert.equal(noRead.line, "PayPal wasn't read for this purchase, so the three records can't be compared.");

const MISMATCH = "PayPal's record of this payment carries fingerprint abc. The store's record does not reproduce it, so it doesn't match.";
const fp: IncidentEvent = { id: 'paypal_fingerprint:O1', at: '2026-10-30T12:06:58.018Z', kind: 'paypal_fingerprint', mode: 'live', actor: 'PayPal', source: 'PayPal order', summary: MISMATCH, match: 'fingerprint_mismatch' };
const forged = threeRecords(shape({ events: [fp, read('no refunds', 'COMPLETED')] }))!;
assert.equal(forged.agree, false);
assert.equal(forged.line, `The records differ. ${MISMATCH}`);
assert.deepEqual(col(forged, 2, 'Fingerprint'), [MISMATCH]);
assert.equal(threeRecords(shape({ events: [fp, down] }))!.agree, false, 'a mismatch stands even when the refunds went unread');

const gone = 'The desk says hold hgone ran a refund of 8.00 USD (PayPal refund RFGONE), but PayPal doesn\'t show it on this payment.';
assert.equal(threeRecords(shape({ events: [read('no refunds', 'COMPLETED'), line('hgone', gone, 'desk_only')] }))!.line, `The records differ. ${gone}`);
assert.equal(threeRecords(shape({ events: [read('1 refund', 'REFUNDED'), line('RFS', 'A refund from the settled dispute.', 'settled')] }))!.agree, true, 'a settled dispute explains its refund');
const lost = threeRecords(shape({ counts: { proposed: 1, approved: 1, executed: 0, outcome_unknown: 1 }, events: [read('no refunds', 'COMPLETED')] }))!;
assert.equal(lost.agree, false);
assert.equal(lost.line, "The records differ. The gate doesn't know how 1 money move ended.");
assert.deepEqual(col(lost, 1, 'Outcome unknown'), ['1']);
assert.equal(threeRecords({ ...inc, purchase: null, decline: { reason: 'x', listings: [] } }), null, 'a decline has no payment to compare');
assert.ok(forged.columns.every((c) => c.mode === 'live' || c.mode === 'recorded'));
console.log('three records: agree or differ and how; a dispute hold is no difference; unread is never agreement; a forged fingerprint is');

const widget = readFileSync('studio/src/widgets/IncidentWidget.tsx', 'utf8'), deskSrc = readFileSync('src/desk.ts', 'utf8');
assert.ok(/records: threeRecords\(/.test(deskSrc), 'the desk adds them to the incident JSON');
assert.ok(!readFileSync('src/incident.ts', 'utf8').includes('threeRecords'), "junco_get_incident doesn't carry a verdict for a fresh Claude");
assert.ok(pageJs.includes('inc.records') && /inc\??\.records/.test(widget));
assert.ok(/class="mode \$\{c\.mode\}"/.test(pageJs) && /jd-mode jd-mode-\$\{c\.mode\}/.test(widget), 'each column wears the LIVE or RECORDED label the rail uses');
assert.ok(/dl\(c\.rows\.map/.test(pageJs) && /esc\(c\.title\)/.test(pageJs) && /esc\(inc\.records\.line\)/.test(pageJs), 'the page escapes the records');
assert.match(pageJs, /@media \(max-width: 760px\)[^\n]*\.records-cols \{ grid-template-columns: minmax\(0, 1fr\)/);
console.log('three records on the pages: the same JSON, labelled, escaped, one column on a phone');
console.log('incident-desk: ok');
