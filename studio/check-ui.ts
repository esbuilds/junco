// Offline check for the desk's design tokens and UI helpers (no browser, no desk, no PayPal).
//   npm run check-ui
import assert from 'node:assert/strict';
import { TOKENS, contrast } from './src/theme';
import { HOLD_STATUS, holdWords } from './src/api';
import { BOOK_FIELDS, FIELDS } from './src/insights';
import { approveLabel, canDecide, checkWords, detailUnderRow, DESK_LAYOUT_KEY, MONEY_METHODS, holdsLine, inGroups, keptTotal, noOtherPurchase, policyWords, quoteParts, rowStatus, splitHolds, standing, startProgress, toPlan, trialLines, whoElseRows, whoElseSummary } from './src/ui';
import type { Bucket, Member, Remedy, Trial, WhoElseRun } from '../src/whoelse-types';
import { readFileSync } from 'node:fs';

// Every text pair the desk uses passes WCAG AA (4.5:1) in both colour schemes.
for (const mode of ['light', 'dark'] as const) {
  const t = TOKENS[mode];
  for (const [fg, bg] of [['ink', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'], ['ink', 'surface-2'], ['ink', 'attn-bg'], ['danger', 'surface'], ['attn-text', 'bg'], ['attn-text', 'surface'], ['attn-text', 'attn-bg'], ['danger', 'danger-bg'], ['accent-ink', 'accent']] as const)
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

// A rejection names who rejected it when that wasn't the owner; the owner's words don't change, and the desk sends no field then.
assert.equal(holdWords({ status: 'rejected' }), 'rejected by owner');
assert.equal(holdWords({ status: 'rejected', decided_by: 'a visitor on their leased case' }), 'rejected by a visitor on their leased case');
assert.equal(holdWords({ status: 'completed', decided_by: 'a visitor on their leased case' }), HOLD_STATUS.completed);
assert.equal(holdWords({ status: 'something new' }), 'something new');

// Who else?: groups in bucket order with totals in cents, the plan only ever from kept silent rows, failures said plainly.
const member = (id: string, bucket: Bucket, paid: string, refunded: string, capture: string | null = `C${id}`): Member => ({ incident_id: id, capture_id: capture, sku: 'WKD-01', paid, instruction: 'a carry-on bag', reason: 'carry-on-friendly', listing: 'L', bucket, why: 'w', quotes: [], dispute_id: null, payment_status: 'COMPLETED', refunded, remaining: (Number(paid) - Number(refunded)).toFixed(2), fingerprint: 'match' });
const whoRun: WhoElseRun = { id: 'r', at: '2026-10-30T00:00:00Z', seed: 'a', cause: { summary: 's', quotes: [] }, draft_note: 'd', notice: 'told', notices: [], corrections: [], trials: [], mode: 'live', model: 'm', cost_usd: 0, members: [member('n', 'not_same', '38.00', '0.00'), member('a', 'complained', '62.00', '0.00'), member('b', 'silent', '0.10', '0.00'), member('c', 'silent', '0.20', '0.00'), member('d', 'silent', '62.00', '2.13'), member('e', 'silent', '62.00', '0.00', null)], remedies: [{ capture_id: 'Cd', incident_id: 'd', amount: '59.87', currency: 'USD', note_to_payer: 'n', hold_id: 'h', hold_status: 'pending', refund_id: null, refund_status: null }] };
const whoRows = whoElseRows(whoRun, new Set(['Cc']), new Set<Bucket>(['not_same']));
assert.deepEqual(whoRows.map((r) => r.id), ['group:silent', 'b', 'c', 'd', 'e', 'group:complained', 'a', 'group:not_same'], 'Never complained first; a closed group keeps its heading and total');
assert.equal(whoRows.find((r) => r.id === 'group:not_same')!.paid, 38);
assert.equal(whoRows[0].paid, 124.3, 'totals add in cents');
assert.deepEqual(toPlan(whoRun, new Set(['Cc'])).map((m) => m.incident_id), ['b'], 'not dropped, not already held, has a capture');
assert.equal(whoRows.find((r) => r.id === 'd')!.can_keep, false, 'a held row is settled');
assert.equal(keptTotal(whoRun, new Set(['Cc'])).remaining, 0.1, 'only what the plan would hold: not dropped, not held');
assert.deepEqual([...whoRows].reverse().sort(inGroups).filter((r) => r.kind === 'group').map((r) => r.bucket), ['silent', 'complained', 'not_same']);
assert.equal([...whoRows].reverse().sort(inGroups)[0].id, 'group:silent', 'a heading stays on top of its members whatever the sort');
assert.equal(noOtherPurchase(whoRun), false);
assert.equal(noOtherPurchase({ ...whoRun, members: [member('a', 'complained', '62.00', '0.00'), member('n', 'not_same', '38.00', '0.00')] }), true, 'the seed itself never counts');
assert.equal(noOtherPurchase({ ...whoRun, members: [member('a', 'complained', '62.00', '0.00')] }), false, 'nothing else was read');
assert.deepEqual(quoteParts('carry-on-friendly dimensions (50x28x25 cm)', [{ field: 'reason', text: 'carry-on-friendly' }, { field: 'reason', text: 'friendly dimensions' }, { field: 'reason', text: 'not there' }, { field: 'listing', text: 'cm' }], 'reason').map((p) => [p.text, p.hit]), [['carry-on-friendly', true], [' dimensions', true], [' (50x28x25 cm)', false]]);
const trial = (sku: string | null): Trial => ({ at: 't', instruction: 'i', budget: '70', outcome: sku ? 'bought' : 'declined', sku, reason: 'r' });
assert.deepEqual(trialLines({ ...whoRun, corrections: [{ sku: 'WKD-01', text: 't', at: 'now' }], trials: [trial('WKD-01'), trial('WKD-03'), trial(null)] }), ['The agent still bought the corrected bag in 1 of 3.', "1 of 3 bought WKD-03, and that listing hasn't been corrected."]);
assert.deepEqual(trialLines({ ...whoRun, corrections: [{ sku: 'WKD-01', text: 't', at: 'now' }], trials: [trial(null)] }), []);

// A refund PayPal confirmed moves the row, its group and the top numbers; the run's snapshot doesn't change, and no other state moves money.
const paidRow = member('p', 'silent', '62.00', '10.00'), rem = (over: Partial<Remedy>): Remedy => ({ capture_id: 'Cp', incident_id: 'p', amount: '52.00', currency: 'USD', note_to_payer: 'n', hold_id: 'h', hold_status: 'completed', refund_id: 'RF1', refund_status: 'COMPLETED', ...over });
assert.deepEqual(standing(paidRow, rem({})), { paid: 6200, refunded: 6200, remaining: 0 });
for (const hold_status of ['pending', 'executing', 'failed', 'expired', 'unknown']) assert.deepEqual(standing(paidRow, rem({ hold_status, refund_id: null })), { paid: 6200, refunded: 1000, remaining: 5200 }, `${hold_status} moved no money`);
assert.equal(paidRow.remaining, '52.00', 'the snapshot is left alone');
const settledRun: WhoElseRun = { ...whoRun, members: [member('a', 'complained', '62.00', '0.00'), paidRow, member('q', 'silent', '62.00', '0.00')], remedies: [rem({})] };
const settledRows = whoElseRows(settledRun, new Set(), new Set());
assert.deepEqual(settledRows.find((r) => r.id === 'p')!.status, { label: 'Refunded', tone: 'done' });
assert.equal(settledRows.find((r) => r.id === 'p')!.remaining, 0);
assert.equal(settledRows.find((r) => r.id === 'group:silent')!.remaining, 62);
const topOf = whoElseSummary(settledRun, new Set());
assert.deepEqual([topOf.silent, topOf.left, topOf.refunded, topOf.current], [2, 62, 1, 'plan']);
// A refused or expired refund can be planned again, as the server allows; anything held, or refunded, can't.
assert.deepEqual(toPlan({ ...settledRun, members: [paidRow], remedies: [rem({ hold_status: 'failed', refund_id: null })] }, new Set()).map((m) => m.incident_id), ['p']);
assert.deepEqual(toPlan({ ...settledRun, members: [paidRow], remedies: [rem({ hold_status: 'pending', refund_id: null })] }, new Set()), []);
assert.deepEqual(toPlan({ ...settledRun, members: [paidRow], remedies: [rem({})] }, new Set()), []);
// The path: the current step follows the work, and a step with work left never wears a check.
const stepOf = (run: WhoElseRun) => { const x = whoElseSummary(run, new Set()); return [x.current, x.done.plan, x.done.approve, x.done.fix]; };
assert.deepEqual(stepOf({ ...settledRun, members: [paidRow], remedies: [] }), ['plan', false, false, false]);
assert.deepEqual(stepOf({ ...settledRun, members: [paidRow], remedies: [rem({ hold_status: 'pending', refund_id: null })] }), ['approve', true, false, false]);
assert.deepEqual(stepOf({ ...settledRun, members: [paidRow], remedies: [rem({})] }), ['fix', true, true, false]);
assert.deepEqual(stepOf({ ...settledRun, members: [paidRow, member('q', 'silent', '62.00', '0.00')], remedies: [rem({ hold_status: 'pending', refund_id: null })] }), ['approve', false, false, false], 'one held, one still to plan');
assert.equal(whoElseSummary({ ...settledRun, corrections: [{ sku: 'WKD-01', text: 't', at: 'now' }], trials: [trial('WKD-03')] }, new Set()).done.fix, false, 'the agent still buys, so the fix is not done');
assert.equal(whoElseSummary({ ...settledRun, corrections: [{ sku: 'WKD-01', text: 't', at: 'now' }], trials: [trial(null)] }, new Set()).done.fix, true);
// A row's detail stays under its row whatever the sort.
const openRows = whoElseRows(whoRun, new Set(), new Set(), 'b').map((data) => ({ data })).reverse().sort((x, y) => inGroups(x.data, y.data));
detailUnderRow(openRows);
const at = openRows.findIndex((n) => n.data.id === 'b');
assert.equal(openRows[at + 1].data.id, 'detail:b');
// The header: PayPal's outage reads as PayPal's, and any other failure keeps today's words.
assert.equal(checkWords(["PayPal's hosted MCP server"]), "PayPal's hosted server is down");
assert.equal(checkWords(['the database']), 'Self-check: 1 failing');
assert.equal(checkWords(["PayPal's hosted MCP server", 'the database']), 'Self-check: 2 failing');
// public/who-else.html can't import ui.ts, so run its copies against it.
const copy = (name: string) => new Function('cents', 'HOLD_PILL', 'BUCKET_PILL', 'AGENT_PILL', `return ${readFileSync(new URL('../public/who-else.html', import.meta.url), 'utf8').match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n(?:const|let|//|function)`))![1]}`);
const pageSrc = readFileSync(new URL('../public/who-else.html', import.meta.url), 'utf8');
const table = (name: string) => new Function(`return ${pageSrc.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});\\n`))![1]}`)();
const pageStanding = copy('standing')((s: string) => Math.round(Number(s) * 100)), pageStatus = copy('rowStatus')(null, table('HOLD_PILL'), table('BUCKET_PILL'), table('AGENT_PILL'));
for (const r of [undefined, rem({}), rem({ hold_status: 'pending', refund_id: null }), rem({ hold_status: 'failed', refund_id: null })]) assert.deepEqual(pageStanding(paidRow, r), standing(paidRow, r));
for (const hold_status of ['pending', 'executing', 'completed', 'failed', 'unknown', 'approved', 'rejected', 'stale', 'expired', 'new']) assert.deepEqual(pageStatus(paidRow, rem({ hold_status, refund_id: null })), rowStatus(paidRow, rem({ hold_status, refund_id: null })), hold_status);
for (const m of [paidRow, member('a', 'complained', '1.00', '0.00'), member('b', 'repaired', '1.00', '1.00'), member('c', 'unclear', '1.00', '0.00'), member('d', 'not_same', '1.00', '0.00'), { ...member('e', 'not_same', '0.00', '0.00'), sku: '' }]) assert.deepEqual(pageStatus(m), rowStatus(m));
// What the row says about a purchase's own agent: the same on both surfaces. A decline leaves the plan; a failed agent can go again.
const heldNow = rem({ hold_status: 'pending', refund_id: null });
for (const [r, n, label] of [[heldNow, { outcome: 'asked' }, 'Agent asked'], [undefined, { outcome: 'declined' }, 'Agent declined'], [undefined, { outcome: 'failed' }, 'Agent failed'], [rem({}), { outcome: 'asked' }, 'Refunded'], [rem({ hold_status: 'rejected', refund_id: null }), { outcome: 'asked' }, 'Rejected']] as const) {
  assert.equal(rowStatus(paidRow, r, false, n).label, label); assert.deepEqual(pageStatus(paidRow, r, n), rowStatus(paidRow, r, false, n));
}
const noted = (outcome: 'asked' | 'declined' | 'failed'): WhoElseRun => ({ ...whoRun, members: [member('a', 'complained', '62.00', '0.00'), member('q', 'silent', '62.00', '0.00')], remedies: [], notices: [{ capture_id: 'Cq', incident_id: 'q', at: 'now', outcome, reason: 'r', hold_id: null }] });
assert.deepEqual([whoElseSummary(noted('declined'), new Set()).plan.length, whoElseSummary(noted('declined'), new Set()).tell.length, whoElseSummary(noted('declined'), new Set()).declined], [0, 0, 1], 'a decline leaves the plan');
assert.equal(whoElseSummary(noted('failed'), new Set()).tell.length, 1, 'a failed agent can be told again');
assert.equal(whoElseSummary({ ...noted('failed'), notices: [] }, new Set()).tell.length, 1);
assert.equal(whoElseSummary({ ...noted('failed'), notices: [] }, new Set(['Cq'])).tell.length, 0, 'a dropped row stays out');
const declinedRow = whoElseRows(noted('declined'), new Set(), new Set()).find((r) => r.id === 'q')!;
assert.deepEqual([declinedRow.can_keep, declinedRow.keep, declinedRow.notice?.outcome, declinedRow.status?.label], [false, false, 'declined', 'Agent declined']);
// No native confirm left where the owner decides money or sign-outs, and a dead control is hidden, never disabled.
for (const f of ['src/widgets/WhoElseWidget.tsx', 'src/widgets/KillSwitch.tsx']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /\bconfirm\(/, `${f} is back on the browser's confirm`);

// Everything visitors read about Who else?: what's true, none of the banned words, and no route that plans or approves on the public page.
const whoPage = readFileSync(new URL('../public/who-else.html', import.meta.url), 'utf8');
const whoWidget = readFileSync(new URL('src/widgets/WhoElseWidget.tsx', import.meta.url), 'utf8');
for (const [name, text] of [['public/who-else.html', whoPage], ['WhoElseWidget.tsx', whoWidget]] as const) {
  assert.match(text, /one sandbox test buyer/, `${name} says one sandbox test buyer`);
  assert.match(text, /our own script filed the disputes/, `${name} says who filed the disputes`);
  assert.match(text, /mistake is real/, `${name} says the mistake is real`);
  assert.match(text, /may not fit/, `${name} says may not fit`);
  assert.match(text, /What the owner says went wrong/, `${name} labels the cause as the owner's`);
  assert.match(text, /What each buyer will read through PayPal/, `${name} shows the buyer's note before a plan`);
  assert.match(text, /a test buyer's agent run by this demo/, `${name} labels the agent plainly`);
  assert.match(text, /same process as the desk/, `${name} says both sides run here`);
  assert.match(text, /run\.draft_note/, `${name} shows the note code built, as it stands`);
  assert.doesNotMatch(text, /AI found the mistake|Claude found the mistake|shared mistake/i, `${name} credits the AI with the mistake`);
  assert.doesNotMatch(text, /recall|—|doesn't fit|\bthe first\b|\bthe only\b/i, `${name} breaks a copy rule`);
}
assert.doesNotMatch(whoPage, /\/plan|\/notify|approve-all|\/correct|\/api\/holds|paypal\.com/, 'the public page has no write but the capped finder');

console.log('check-ui: ok');
