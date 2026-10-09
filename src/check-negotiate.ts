// Negotiation check: the clamps code applies to whatever the model proposes.
import assert from 'node:assert/strict';
import { nextMove, DEFAULT_BOUNDS } from './negotiate.js';

const n = (offers: number[], bounds = DEFAULT_BOUNDS) => ({ amount: 48, bounds, rounds: offers.map((o) => ({ at: '', offered: o, message: '', buyer_asked: null })) });
assert.deepEqual(nextMove(n([]), 9.6, null), { kind: 'offer', amount: 9.6 });            // opening offer
assert.deepEqual(nextMove(n([9.6]), 40, null), { kind: 'offer', amount: 24 });            // model asks past the 50% ceiling: clamped to 24
assert.deepEqual(nextMove(n([9.6]), 5, null), { kind: 'offer', amount: 10.6 });           // never offers less than last time
assert.equal(nextMove(n([9.6]), 15, 30).kind, 'ask_owner');                               // buyer wants 30 > ceiling 24: owner decides
assert.equal(nextMove(n([9.6, 15, 20]), 22, null).kind, 'ask_owner');                     // 3 rounds used
assert.equal(nextMove(n([24]), 24, null).kind, 'ask_owner');                              // already at the ceiling
assert.deepEqual(nextMove(n([9.6]), null, null), { kind: 'wait' });                       // nothing to do until the buyer answers
console.log('negotiation clamps: ceiling, never backwards, buyer over ceiling, round limit, at ceiling, wait');
