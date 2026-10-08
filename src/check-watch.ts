// Shipment watch check: the flag rules and their edges, offline.
import assert from 'node:assert/strict';
import { assess } from './watch.js';

const paid = '2026-10-08T12:00:00Z', at = (iso: string) => Date.parse(iso);
const base = { captured_at: paid, trackers: [] as { number: string; status: string }[], ship_postal: '95131', payer_postal: '95131', protection: 'ELIGIBLE' };
assert.equal(assess(base, 2, at('2026-10-10T11:59:00Z')).status, 'watching'); // inside the ship-by window
assert.deepEqual(assess(base, 2, at('2026-10-10T12:01:00Z')).flags.map((f) => f.code), ['no_tracking']); // just past it
assert.equal(assess(base, 2, at('2026-10-10T12:01:00Z')).ship_by, '2026-10-10T12:00:00.000Z');
assert.equal(assess({ ...base, trackers: [{ number: '9400', status: 'SHIPPED' }] }, 2, at('2026-10-20T00:00:00Z')).status, 'protected');
assert.equal(assess({ ...base, trackers: [{ number: '9400', status: 'CANCELLED' }] }, 2, at('2026-10-20T00:00:00Z')).status, 'at_risk'); // cancelled label is not tracking
assert.deepEqual(assess({ ...base, payer_postal: '10001' }, 2, at(paid)).flags.map((f) => f.code), ['address_differs']);
assert.equal(assess({ ...base, payer_postal: '95131-1234' }, 2, at(paid)).flags.length, 0); // ZIP+4 matches
assert.equal(assess({ ...base, payer_postal: null }, 2, at(paid)).flags.length, 0); // unknown buyer address: no flag
assert.deepEqual(assess({ ...base, protection: 'NOT_ELIGIBLE', trackers: [{ number: '9400', status: 'SHIPPED' }] }, 2, at(paid)).flags.map((f) => f.code), ['not_eligible']);
console.log('shipment watch: ship-by edge, cancelled labels, ZIP+4, unknown address, PayPal eligibility');
