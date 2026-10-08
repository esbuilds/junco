// Check for the AI layer. Validator cases are offline; the last step makes one real Claude call.
import assert from 'node:assert/strict';
import { collectEvidence, validate, recommend, type Recommendation } from './recommend.js';
import { sandboxCtx } from './server.js';

const dispute = {
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', dispute_amount: { value: '48.00', currency_code: 'USD' },
  links: [{ rel: 'self' }, { rel: 'make_offer' }, { rel: 'accept_claim' }, { rel: 'send_message' }],
};
const ev = collectEvidence(dispute, [{ source: 'merchant shipping', text: 'USPS 9400 delivered' }]);
const base: Recommendation = { decision: 'offer', summary: '', claims: [{ text: 'Delivered', evidence_ids: ['E2'] }], offer_amount: '10.00', evidence_type: null, message_to_buyer: null, would_change_mind: null, change_reason: null };

assert.deepEqual(validate(base, ev, dispute), []);
assert.match(validate({ ...base, claims: [{ text: 'Buyer admitted receipt', evidence_ids: ['E9'] }] }, ev, dispute)[0], /missing evidence E9/);
assert.match(validate({ ...base, claims: [{ text: 'x', evidence_ids: [] }] }, ev, dispute)[0], /Uncited/);
assert.match(validate({ ...base, offer_amount: '60.00' }, ev, dispute)[0], /at most the disputed 48/);
assert.match(validate({ ...base, decision: 'contest', evidence_type: 'PROOF_OF_FULFILLMENT' }, ev, dispute)[0], /does not allow provide_evidence/);
assert.match(validate({ ...base, decision: 'message' }, ev, dispute).join(), /without message_to_buyer/);
assert.deepEqual(validate({ ...base, decision: 'wait' }, ev, { ...dispute, links: [{ rel: 'self' }] }), []);
assert.deepEqual(validate({ ...base, decision: 'contest', evidence_type: 'OTHER' }, ev, { ...dispute, links: [{ rel: 'provide_supporting_info' }] }), []);
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
