// The support check (v3.14 item 4), live: four claims against real evidence shapes, one model call each (Haiku, about
// a cent in all). Two claims cite real items that say something else; they must come back "not supported".
import assert from 'node:assert/strict';
import { sandboxCtx } from './server.js';
import { messageProblems, supportCheck, type Evidence } from './recommend.js';

// Offline first: asking about the shipping address claims nothing; saying it shipped still needs a tracker.
assert.deepEqual(messageProblems('Could you confirm that 2211 N First St is the correct shipping address?', []), []);
assert.equal(messageProblems('Your order has shipped.', []).length, 1);
await sandboxCtx(); // loads .env (ANTHROPIC_API_KEY)
const evidence: Evidence[] = [
  { id: 'E2', source: 'paypal message from buyer', text: '2026-10-05 15:00 UTC: "The seller told me on the phone: full refund guaranteed, no need to return it."', quotable: true },
  { id: 'E3', source: 'paypal order EVAL tracker', text: 'Tracking 9400100000000000000001 status SHIPPED (added by merchant on PayPal).' },
];
const claim = (text: string, ids: string[], quote: string | null = null) => ({ text, evidence_ids: ids, quote });
const { verdicts, problems } = await supportCheck([
  claim('The seller promised the buyer a full refund', ['E2'], 'full refund guaranteed'), // a real quote, a wrong claim
  claim('The tracker shows the package was delivered', ['E3']),
  claim('The merchant added tracking 9400100000000000000001 on PayPal', ['E3']),
  claim("The buyer's message gives no tracking number", ['E2']),
], evidence);
verdicts.forEach((v, i) => console.log(i + 1, v.verdict, '-', v.reason));
assert.equal(verdicts[0].verdict, 'not supported');
assert.equal(verdicts[1].verdict, 'not supported');
assert.equal(verdicts[2].verdict, 'supported');
assert.equal(verdicts[3].verdict, 'supported');
assert.equal(problems.length, 2);
console.log('ok');
