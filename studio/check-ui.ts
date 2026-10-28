// Offline check for the desk's design tokens and UI helpers (no browser, no desk, no PayPal).
//   npm run check-ui
import assert from 'node:assert/strict';
import { TOKENS, contrast } from './src/theme';
import { approveLabel, DESK_LAYOUT_KEY, splitHolds, startProgress } from './src/ui';
import { readFileSync } from 'node:fs';

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

// The saved-layout key lives in one place: Policy's "Reset the layout" must clear the key the Desk saves under.
assert.equal(DESK_LAYOUT_KEY, 'jd-desk-layout-v2');
for (const f of ['src/App.tsx', 'src/widgets/PolicyWidget.tsx'])
  assert.ok(!/'jd-desk-layout/.test(readFileSync(new URL(f, import.meta.url), 'utf8')), `${f} spells the layout key instead of importing DESK_LAYOUT_KEY`);

// Try it's eval verdicts are told apart by more than their words: wrong reads as a failure, pass does not.
const css = readFileSync(new URL('src/styles.css', import.meta.url), 'utf8');
assert.match(css, /\.jd-v-wrong\s*\{[^}]*--jd-danger/, 'a wrong verdict uses the danger colour');
assert.match(css, /\.jd-v-pass\s*\{/, 'a passing verdict has its own style');

console.log('check-ui: ok');
