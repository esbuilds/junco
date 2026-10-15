// Check for the AI layer. Validator cases are offline; the last step makes one real Claude call.
import assert from 'node:assert/strict';
import { collectEvidence, validate, recommend, type Evidence, type Recommendation } from './recommend.js';
import { sandboxCtx } from './server.js';

const dispute = {
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', dispute_amount: { value: '48.00', currency_code: 'USD' },
  links: [{ rel: 'self' }, { rel: 'make_offer' }, { rel: 'accept_claim' }, { rel: 'send_message' }],
};
const ev = collectEvidence(dispute, [{ source: 'merchant shipping', text: 'USPS 9400 delivered' }]);
const base: Recommendation = { decision: 'offer', summary: '', claims: [{ text: 'Delivered', evidence_ids: ['E2'], quote: 'USPS 9400 delivered' }], offer_amount: '10.00', evidence_type: null, message_to_buyer: null, would_change_mind: null, change_reason: null };

assert.deepEqual(validate(base, ev, dispute), []);
assert.match(validate({ ...base, claims: [{ text: 'Buyer admitted receipt', evidence_ids: ['E9'], quote: null }] }, ev, dispute)[0], /missing evidence E9/);
assert.match(validate({ ...base, claims: [{ text: 'x', evidence_ids: [], quote: null }] }, ev, dispute)[0], /Uncited/);
assert.match(validate({ ...base, offer_amount: '60.00' }, ev, dispute)[0], /at most the disputed 48/);
assert.match(validate({ ...base, decision: 'contest', evidence_type: 'PROOF_OF_FULFILLMENT' }, ev, dispute)[0], /does not allow provide_evidence/);
assert.match(validate({ ...base, decision: 'message' }, ev, dispute).join(), /without message_to_buyer/);
assert.deepEqual(validate({ ...base, decision: 'wait' }, ev, { ...dispute, links: [{ rel: 'self' }] }), []);
assert.deepEqual(validate({ ...base, decision: 'contest', evidence_type: 'OTHER' }, ev, { ...dispute, links: [{ rel: 'provide_supporting_info' }] }), []);
// The buyer's issue fields on a not-as-described case: a PayPal summary (not quotable), the buyer's description quoted.
const nad = collectEvidence({ ...dispute, extensions: { merchandize_dispute_properties: { product_details: { sub_reasons: ['DIFFERENT'], description: 'Too deep for the sizer.' } } } });
assert.deepEqual(nad.slice(1).map((e) => [e.quotable, e.text.slice(0, 40)]), [[false, 'What the buyer reported as filed with Pa'], [true, 'Too deep for the sizer.']]);
// Quote check: source text (E2, a merchant record) needs a word-for-word quote; JUNCO's own summary (E1) doesn't.
assert.equal(ev[0].quotable, false); assert.equal(ev[1].quotable, true);
const claim = (evidence_ids: string[], quote: string | null) => ({ ...base, claims: [{ text: 'Delivered', evidence_ids, quote }] });
assert.deepEqual(validate(claim(['E2'], null), ev, dispute), []); // v3.12 call 5: unquoted passes, shown as "cited, not quoted"
assert.match(validate(claim(['E2'], 'UPS 9400 delivered to the porch'), ev, dispute)[0], /Quote not found/);
assert.match(validate(claim(['E2'], 'USPS'), ev, dispute)[0], /Quote not found/); // too short to mean anything
assert.deepEqual(validate(claim(['E2'], '  USPS 9400\n delivered '), ev, dispute), []); // whitespace only
assert.deepEqual(validate(claim(['E1'], null), ev, dispute), []);
console.log('quote check: wrong and one-word quotes caught; an unquoted claim passes; JUNCO-written evidence needs none');

// Message to the buyer (v3.12 update R2), on GJF as it was on Oct 10: never shipped, PayPal had requested proof.
const gjf: Evidence[] = [
  { id: 'E1', source: 'paypal', text: 'Reason: MERCHANDISE_OR_SERVICE_NOT_RECEIVED. Amount: 48.00 USD. Stage: INQUIRY.' },
  { id: 'E2', source: 'paypal evidence on file', text: 'PayPal asked the seller for proof of fulfillment; not provided yet.' },
  { id: 'E3', source: 'paypal transaction', text: 'Paid 48.00 USD on 2026-10-10T17:41:35.000Z.' },
];
const msg = (m: string) => validate({ ...base, decision: 'message', message_to_buyer: m }, gjf, dispute);
const sent = "Hi John, thanks for your order of the Canvas tote. It was placed today and has been shipped to 2211 N First St, San Jose, CA 95131. Carriers usually need a few business days to deliver, and you can follow it with the tracking number we've provided.";
assert.match(msg(sent).join(), /asserts shipping/); // the message JUNCO actually sent
assert.deepEqual(msg("Sorry for the wait. Your order hasn't shipped yet; we'll update you on Oct 10 2026 at the latest."), []);
assert.match(msg('Your tracking number is 9400100000000000000999.').join(), /tracking-like number 9400100000000000000999/);
// Seen live in Break the mandate (Oct 11): a promise to update is not a shipping claim; a promise to ship still is.
assert.deepEqual(msg("We'll send you tracking details as soon as they're available."), []);
assert.deepEqual(msg('We will update you here with shipping details as soon as they are available.'), []);
assert.match(msg('It will ship tomorrow and arrive by Friday.').join(), /asserts shipping/);
assert.match(msg('We will refund you if nothing changes by Oct 20.').join(), /date \(10\/20\)/);
assert.match(validate({ ...base, decision: 'message', message_to_buyer: 'Your order has shipped.' }, [...gjf, { id: 'E4', source: 'paypal order X tracker', text: 'Tracking 9400100000000000000003 status CANCELLED (added by merchant on PayPal).' }], dispute).join(), /asserts shipping/); // a cancelled label isn't shipping
const withTracker = [...gjf, { id: 'E4', source: 'paypal order X tracker', text: 'Tracking 9400100000000000000006 status SHIPPED (added by merchant on PayPal).' }];
assert.deepEqual(validate({ ...base, decision: 'message', message_to_buyer: 'It shipped with USPS 9400100000000000000006.' }, withTracker, dispute), []);
console.log('message check: GJF\'s false "shipped" message blocked; honest not-shipped, unknown tracking number and date caught; tracked shipment passes');
console.log('validator: fabricated citation, uncited claim, oversized offer, disallowed action all caught');

const ctx = await sandboxCtx();
const out = await recommend(ctx, 'PP-R-ERP-10190210', [
  { source: 'USPS tracking 9400100000000000000000', text: 'Delivered, front door, San Jose CA 95131, Oct 4 2026 2:14pm.' },
]);
console.log(JSON.stringify({ recommendation: out.recommendation, problems: out.problems }, null, 2));
assert(out.evidence.some((e) => e.source.startsWith('paypal order')), 'order facts should come from PayPal');
assert(out.recommendation, 'no recommendation');
assert.deepEqual(out.problems, [], 'recommendation should be actionable');
console.log('ok');
