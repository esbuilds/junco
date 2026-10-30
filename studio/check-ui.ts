// Offline check for the desk's design tokens and UI helpers (no browser, no desk, no PayPal).
//   npm run check-ui
import assert from 'node:assert/strict';
import { TOKENS, contrast } from './src/theme';
import { BOOK_FIELDS, FIELDS } from './src/insights';
import { approveLabel, canDecide, DESK_LAYOUT_KEY, MONEY_METHODS, holdsLine, policyWords, splitHolds, startProgress } from './src/ui';
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
const s = splitHolds([{ status: 'pending', method: 'm' }, { status: 'executing', method: 'm' }, { status: 'failed', method: 'm' }, { status: 'completed', method: 'm' }, { status: 'unknown', method: 'm' }, { status: 'pending', method: 'm' }]);
assert.equal(s.pending.length, 2);
assert.equal(s.unconfirmed.length, 3);
assert.deepEqual(splitHolds([]), { pending: [], money: [], unconfirmed: [] });

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

// The KPI counts what the Gate record counts: pending money moves (the server's MONEY list in src/gate.ts).
const serverMoney = JSON.parse(readFileSync(new URL('../src/gate.ts', import.meta.url), 'utf8').match(/export const MONEY = (\[[^\]]*\])/)![1].replace(/'/g, '"'));
assert.deepEqual([...MONEY_METHODS].sort(), [...serverMoney].sort());
const live = splitHolds([{ status: 'pending', method: 'create_refund' }, { status: 'pending', method: 'send_invoice' }, { status: 'pending', method: 'accept_dispute_claim' }, { status: 'executing', method: 'create_refund' }]);
assert.equal(live.money.length, 2);
assert.equal(live.pending.length, 3);
assert.equal(holdsLine(live), '2 held money moves · 1 other held action');
assert.equal(holdsLine(splitHolds([{ status: 'pending', method: 'create_refund' }])), '1 held money move');
assert.equal(holdsLine(splitHolds([{ status: 'pending', method: 'send_invoice' }])), '0 held money moves · 1 other held action');

// Who may decide a hold (the server's v3.12 rule): the owner any hold, a visitor only one on the case they lease.
const onCase = { args: { dispute_id: 'PP-R-A' } }, onPayment = { args: { capture_id: 'C1' } };
assert.equal(canDecide(onCase, { owner: true, own: null }), true);
assert.equal(canDecide(onPayment, { owner: true, own: null }), true);
assert.equal(canDecide(onCase, { owner: false, own: 'PP-R-A' }), true);
assert.equal(canDecide(onCase, { owner: false, own: 'PP-R-B' }), false);
assert.equal(canDecide(onPayment, { owner: false, own: 'PP-R-A' }), false);
assert.equal(canDecide(onCase, { owner: false, own: null }), false);
assert.equal(canDecide(onCase, { owner: undefined, own: undefined }), false); // still loading: no buttons yet

// Why it's held, in words: the policy rule, not its code.
assert.equal(policyWords('policy: send_invoice = hold'), 'Your policy: invoices wait for you');
assert.equal(policyWords('policy: accept_dispute_claim = hold'), 'Your policy: accepting a claim waits for you');
assert.equal(policyWords('policy: create_refund = hold'), 'Your policy: refunds wait for you');
assert.equal(policyWords('policy: make_dispute_offer = hold'), 'Your policy: offers wait for you');
assert.equal(policyWords('policy: add_order_tracking = hold'), 'Your policy: add order tracking waits for you');
assert.equal(policyWords('offer above the $25.00 auto-offer limit'), 'offer above the $25.00 auto-offer limit'); // anything else as written

// A widget picks its fields by name across every source, so a Books field named like a dispute field would break Matching.
assert.deepEqual(BOOK_FIELDS.filter((b) => FIELDS.some((f) => f.id === b.id)), []);

console.log('check-ui: ok');
