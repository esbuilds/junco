// Offline check for the desk's design tokens and UI helpers (no browser, no desk, no PayPal).
//   npm run check-ui
import assert from 'node:assert/strict';
import { TOKENS, contrast } from './src/theme';
import { approveLabel, splitHolds, startProgress } from './src/ui';

// Every text pair the desk uses passes WCAG AA (4.5:1) in both colour schemes.
for (const mode of ['light', 'dark'] as const) {
  const t = TOKENS[mode];
  for (const [fg, bg] of [['ink', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['attn-text', 'bg'], ['attn-text', 'surface'], ['attn-text', 'attn-bg'], ['danger', 'danger-bg'], ['accent-ink', 'accent']] as const)
    assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${mode} ${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
}
assert.equal(TOKENS.light.attn, '#c2531f');
assert.equal(TOKENS.light['attn-text'], '#b5471c');
assert.equal(TOKENS.light.accent, '#18181b');

// Waiting for your OK counts pending holds only; approved-but-unconfirmed ones are grouped apart, finished ones dropped.
const s = splitHolds([{ status: 'pending' }, { status: 'executing' }, { status: 'failed' }, { status: 'completed' }, { status: 'unknown' }, { status: 'pending' }]);
assert.equal(s.pending.length, 2);
assert.equal(s.unconfirmed.length, 3);
assert.deepEqual(splitHolds([]), { pending: [], unconfirmed: [] });

// The approve button names the move; an unknown method never reads "Approve undefined".
assert.equal(approveLabel('create_refund'), 'Approve refund');
assert.equal(approveLabel('accept_dispute_claim'), 'Approve claim acceptance');
assert.equal(approveLabel('add_order_tracking'), 'Approve add order tracking');

// Start here: the current step is the first not yet opened; done counts opened steps that still exist.
const T6 = ['a', 'b', 'c', 'd', 'e', 'f'];
assert.deepEqual(startProgress([], T6), { current: 0, done: 0 });
assert.deepEqual(startProgress(['a', 'c'], T6), { current: 1, done: 2 });
assert.deepEqual(startProgress(T6, T6), { current: 5, done: 6 });
assert.deepEqual(startProgress(['zzz'], T6), { current: 0, done: 0 });

console.log('check-ui: ok');
