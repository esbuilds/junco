// Plan trigger check: the time and message edges that decide when an approved plan step runs.
import assert from 'node:assert/strict';
import { triggered } from './plan.js';

const approved = '2026-10-08T12:00:00Z', now = Date.parse('2026-10-10T13:00:00Z');
const msg = (posted_by: string, time_posted: string) => ({ status: 'WAITING_FOR_BUYER_RESPONSE', messages: [{ posted_by, time_posted }] });
assert.equal(triggered('now', {}, approved, now), true);
assert.equal(triggered('buyer_silent_48h', msg('SELLER', '2026-10-08T12:59:00Z'), approved, now), true); // 48h01m
assert.equal(triggered('buyer_silent_48h', msg('SELLER', '2026-10-08T13:01:00Z'), approved, now), false); // 47h59m
assert.equal(triggered('buyer_silent_48h', msg('BUYER', '2026-10-01T00:00:00Z'), approved, now), false); // buyer spoke last
assert.equal(triggered('buyer_replies', msg('BUYER', '2026-10-09T00:00:00Z'), approved, now), true);
assert.equal(triggered('buyer_replies', msg('BUYER', '2026-10-07T00:00:00Z'), approved, now), false); // before approval
assert.equal(triggered('paypal_review', { status: 'UNDER_REVIEW' }, approved, now), true);
assert.equal(triggered('paypal_review', { status: 'WAITING_FOR_SELLER_RESPONSE' }, approved, now), false);
assert.equal(triggered('something_else', {}, approved, now), false);
console.log('plan triggers: 48h edge, who spoke last, replies before approval, review status, unknown trigger');
