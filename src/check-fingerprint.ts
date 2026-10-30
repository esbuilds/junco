// Mandate fingerprint check, offline, no PayPal: the hash is pinned for fixed inputs, a record changed after capture no
// longer reproduces PayPal's copy, and an order from before fingerprints reads as not recorded, never as a mismatch.
import assert from 'node:assert/strict';
import { checkAgainstPayPal, fingerprint } from './fingerprint.js';

const m = { instruction: 'waterproof bag for kayaking', budget: '70', model: 'claude-sonnet-5-5', at: '2026-10-30T02:28:00.000Z' };
assert.equal(fingerprint(m), '0a89f5b14315'); // pinned: a change here breaks every fingerprint already at PayPal
assert.equal(fingerprint({ at: m.at, model: m.model, budget: m.budget, instruction: m.instruction }), '0a89f5b14315'); // key order
console.log('hash: same inputs, same 12 hex, whatever the key order');

const stored = { instruction: m.instruction, budget: m.budget, mandate: { model: m.model, at: m.at, fingerprint: '0a89f5b14315' } };
const atPayPal = 'junco:m:0a89f5b14315';
assert.equal(checkAgainstPayPal(stored, atPayPal).verdict, 'match');
for (const tampered of [{ ...stored, budget: '700' }, { ...stored, instruction: 'any bag' }, { ...stored, mandate: { ...stored.mandate, model: 'other' } }, { ...stored, mandate: { ...stored.mandate, at: '2026-10-30T02:29:00.000Z' } }])
  assert.equal(checkAgainstPayPal(tampered, atPayPal).verdict, 'mismatch', JSON.stringify(tampered));
assert.match(checkAgainstPayPal({ ...stored, budget: '700' }, atPayPal).text, /doesn't match/);
console.log("tamper: a changed budget, instruction, model or time no longer matches PayPal's copy");

const old = { instruction: m.instruction, budget: m.budget };
for (const id of [undefined, 'junco:m:0a89f5b14315', 'something-else']) {
  const c = checkAgainstPayPal(old, id);
  assert.equal(c.verdict, 'before fingerprints'); assert.equal(c.text, 'Not recorded at PayPal (placed before fingerprints).');
}
assert.equal(checkAgainstPayPal(stored, undefined).verdict, 'not recorded');
console.log('older orders: not recorded at PayPal (placed before fingerprints), never a mismatch');
