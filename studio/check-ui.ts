// Offline check for the desk's design tokens and UI helpers (no browser, no desk, no PayPal).
//   npm run check-ui
import assert from 'node:assert/strict';
import { TOKENS, contrast } from './src/theme';
import { BOOK_FIELDS, FIELDS } from './src/insights';
import { approveLabel, canDecide, DESK_LAYOUT_KEY, MONEY_METHODS, holdsLine, inGroups, keptTotal, noOtherPurchase, policyWords, quoteParts, splitHolds, startProgress, toPlan, trialLines, whoElseRows } from './src/ui';
import type { Bucket, Member, Trial, WhoElseRun } from '../src/whoelse-types';
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

// Claude refuses a whole turn if two tools share a name, and the desk's list and the assistant's own both have junco_get_incident.
assert.match(readFileSync(new URL('src/studioAi.ts', import.meta.url), 'utf8'), /paypalTools\.filter\(\(t\) => !junco\.some\(\(j\) => j\.name === t\.name\)\)/, "the assistant's own tools must win over the desk's");

// Who else?: groups in bucket order with totals in cents, the plan only ever from kept silent rows, failures said plainly.
const member = (id: string, bucket: Bucket, paid: string, refunded: string, capture: string | null = `C${id}`): Member => ({ incident_id: id, capture_id: capture, sku: 'WKD-01', paid, instruction: 'a carry-on bag', reason: 'carry-on-friendly', listing: 'L', bucket, why: 'w', quotes: [], dispute_id: null, payment_status: 'COMPLETED', refunded, remaining: (Number(paid) - Number(refunded)).toFixed(2), fingerprint: 'match' });
const whoRun: WhoElseRun = { id: 'r', at: '2026-10-30T00:00:00Z', seed: 'a', cause: { summary: 's', quotes: [] }, corrections: [], trials: [], mode: 'live', model: 'm', cost_usd: 0, members: [member('n', 'not_same', '38.00', '0.00'), member('a', 'complained', '62.00', '0.00'), member('b', 'silent', '0.10', '0.00'), member('c', 'silent', '0.20', '0.00'), member('d', 'silent', '62.00', '2.13'), member('e', 'silent', '62.00', '0.00', null)], remedies: [{ capture_id: 'Cd', incident_id: 'd', amount: '59.87', currency: 'USD', note_to_payer: 'n', hold_id: 'h', hold_status: 'pending', refund_id: null, refund_status: null }] };
const whoRows = whoElseRows(whoRun, new Set(['Cc']), new Set<Bucket>(['not_same']));
assert.deepEqual(whoRows.map((r) => r.id), ['group:silent', 'b', 'c', 'd', 'e', 'group:complained', 'a', 'group:not_same'], 'Never complained first; a closed group keeps its heading and total');
assert.equal(whoRows.find((r) => r.id === 'group:not_same')!.paid, 38);
assert.equal(whoRows[0].paid, 124.3, 'totals add in cents');
assert.deepEqual(toPlan(whoRun, new Set(['Cc'])).map((m) => m.incident_id), ['b'], 'not dropped, not already held, has a capture');
assert.equal(whoRows.find((r) => r.id === 'd')!.can_keep, false, 'a held row is settled');
assert.equal(keptTotal(whoRun, new Set(['Cc'])).remaining, 59.97);
assert.deepEqual([...whoRows].reverse().sort(inGroups).filter((r) => r.kind === 'group').map((r) => r.bucket), ['silent', 'complained', 'not_same']);
assert.equal([...whoRows].reverse().sort(inGroups)[0].id, 'group:silent', 'a heading stays on top of its members whatever the sort');
assert.equal(noOtherPurchase(whoRun), false);
assert.equal(noOtherPurchase({ ...whoRun, members: [member('a', 'complained', '62.00', '0.00'), member('n', 'not_same', '38.00', '0.00')] }), true, 'the seed itself never counts');
assert.equal(noOtherPurchase({ ...whoRun, members: [member('a', 'complained', '62.00', '0.00')] }), false, 'nothing else was read');
assert.deepEqual(quoteParts('carry-on-friendly dimensions (50x28x25 cm)', [{ field: 'reason', text: 'carry-on-friendly' }, { field: 'reason', text: 'friendly dimensions' }, { field: 'reason', text: 'not there' }, { field: 'listing', text: 'cm' }], 'reason').map((p) => [p.text, p.hit]), [['carry-on-friendly', true], [' dimensions', true], [' (50x28x25 cm)', false]]);
const trial = (sku: string | null): Trial => ({ at: 't', instruction: 'i', budget: '70', outcome: sku ? 'bought' : 'declined', sku, reason: 'r' });
assert.deepEqual(trialLines({ ...whoRun, corrections: [{ sku: 'WKD-01', text: 't', at: 'now' }], trials: [trial('WKD-01'), trial('WKD-03'), trial(null)] }), ['The agent still bought the corrected bag in 1 of 3.', "1 of 3 bought WKD-03, and that listing hasn't been corrected."]);
assert.deepEqual(trialLines({ ...whoRun, corrections: [{ sku: 'WKD-01', text: 't', at: 'now' }], trials: [trial(null)] }), []);

// Everything visitors read about Who else?: what's true, none of the banned words, and no route that plans or approves on the public page.
const whoPage = readFileSync(new URL('../public/who-else.html', import.meta.url), 'utf8');
const whoWidget = readFileSync(new URL('src/widgets/WhoElseWidget.tsx', import.meta.url), 'utf8');
for (const [name, text] of [['public/who-else.html', whoPage], ['WhoElseWidget.tsx', whoWidget]] as const) {
  assert.match(text, /one sandbox test buyer/, `${name} says one sandbox test buyer`);
  assert.match(text, /our own script filed the disputes/, `${name} says who filed the disputes`);
  assert.match(text, /mistake is real/, `${name} says the mistake is real`);
  assert.match(text, /may not fit/, `${name} says may not fit`);
  assert.match(text, /What the owner says went wrong/, `${name} labels the cause as the owner's`);
  assert.doesNotMatch(text, /AI found the mistake|Claude found the mistake|shared mistake/i, `${name} credits the AI with the mistake`);
  assert.doesNotMatch(text, /recall|—|doesn't fit|\bthe first\b|\bthe only\b/i, `${name} breaks a copy rule`);
}
assert.doesNotMatch(whoPage, /\/plan|approve-all|\/correct|\/api\/holds|paypal\.com/, 'the public page has no write but the capped finder');

console.log('check-ui: ok');
