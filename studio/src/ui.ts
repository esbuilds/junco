// Small UI rules shared by the desk widgets, kept free of React so check-ui can pin them.
import { human } from './api';
import type { AgentNotice, Bucket, Member, Quote, QuoteField, Remedy, WhoElseRun } from '../../src/whoelse-types';

// Waiting for your OK: pending holds only. Approved holds PayPal hasn't confirmed are shown apart; the rest are finished.
// money: the pending holds the Gate record counts as money moves (same list as MONEY in src/gate.ts; check-ui pins it),
// so the KPI and the Gate record's "waiting" always agree. Other held actions (an invoice) still wait in the table.
export const MONEY_METHODS = ['make_dispute_offer', 'accept_dispute_claim', 'create_refund'];
const UNCONFIRMED = new Set(['executing', 'unknown', 'failed']);
export function splitHolds<H extends { status: string; method: string }>(holds: H[]) {
  const pending = holds.filter((h) => h.status === 'pending');
  return { pending, money: pending.filter((h) => MONEY_METHODS.includes(h.method)), unconfirmed: holds.filter((h) => UNCONFIRMED.has(h.status)) };
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
export function holdsLine({ pending, money }: { pending: unknown[]; money: unknown[] }) {
  const other = pending.length - money.length;
  return [plural(money.length, 'held money move'), other && plural(other, 'other held action')].filter(Boolean).join(' · ');
}

// Who may decide a hold, as the server rules (v3.12): the owner any hold, a visitor only one on the case they lease
// (own, from /api/start). Unknown yet (still loading) means no buttons.
export const canDecide = (h: { args?: any }, who: { owner?: boolean; own?: string | null }) =>
  !!who.owner || (!!who.own && h.args?.dispute_id === who.own);

// "policy: send_invoice = hold" in words. Any other reason (a limit, a re-check) is shown as written.
const POLICY_NOUN: Record<string, [string, boolean]> = { send_invoice: ['invoices', true], accept_dispute_claim: ['accepting a claim', false], create_refund: ['refunds', true], make_dispute_offer: ['offers', true], provide_dispute_evidence: ['evidence', false] };
export function policyWords(reason: string) {
  const m = /^policy: (\w+) = hold$/.exec(reason);
  if (!m) return reason;
  const [noun, many] = POLICY_NOUN[m[1]] ?? [human(m[1]), false];
  return `Your policy: ${noun} ${many ? 'wait' : 'waits'} for you`;
}

const APPROVE: Record<string, string> = { create_refund: 'Approve refund', make_dispute_offer: 'Approve offer', accept_dispute_claim: 'Approve claim acceptance', provide_dispute_evidence: 'Approve evidence' };
export const approveLabel = (method: string) => APPROVE[method] ?? `Approve ${human(method)}`;

// Start here: the current step is the first this browser hasn't opened (the last once all are); done counts opened steps.
export function startProgress(opened: string[], titles: string[]) {
  const i = titles.findIndex((t) => !opened.includes(t));
  return { current: i < 0 ? titles.length - 1 : i, done: titles.filter((t) => opened.includes(t)).length };
}

// Who else?: the grid's rows. Bucket groups and their money totals are built here, in cents, because grouping is an AG Grid
// Enterprise module and the desk stays on Community, which needs no licence question.
// ponytail: a collapsed group just leaves its members out of rowData, so a group can't be filtered as a group.
export const BUCKETS: [Bucket, string][] = [['silent', 'Never complained'], ['complained', 'Complained'], ['repaired', 'Already repaired'], ['unclear', 'Unclear'], ['not_same', 'Not the same']];
export type RowTone = 'done' | 'attn' | 'bad' | 'ready' | 'quiet';
export type WhoElseRow = { id: string; kind: 'group' | 'member' | 'total' | 'detail'; bucket: Bucket; label: string; open?: boolean; keep?: boolean; can_keep?: boolean; paid: number; refunded: number; remaining: number; member?: Member; remedy?: Remedy; notice?: AgentNotice; status?: { label: string; tone: RowTone } };
const cents = (s: string) => Math.round(Number(s) * 100);
const remedyOf = (run: WhoElseRun, m: Member) => m.capture_id ? run.remedies.find((r) => r.capture_id === m.capture_id) : undefined;
const noticeOf = (run: WhoElseRun, m: Member) => m.capture_id ? run.notices.find((n) => n.capture_id === m.capture_id) : undefined;

// A run's money is what PayPal showed when it read. After that, a remedy with PayPal's refund id has moved it, the same test the
// server's score uses, so the row, its group and the top numbers all read from here. public/who-else.html repeats this (check-ui).
export const standing = (m: Pick<Member, 'paid' | 'refunded' | 'remaining'>, r?: Pick<Remedy, 'refund_id' | 'amount'>) => {
  const moved = r?.refund_id ? cents(r.amount) : 0;
  return { paid: cents(m.paid), refunded: cents(m.refunded) + moved, remaining: Math.max(0, cents(m.remaining) - moved) };
};
const totals = (run: WhoElseRun, rows: Member[]) => {
  const t = rows.map((m) => standing(m, remedyOf(run, m)));
  return { paid: t.reduce((n, x) => n + x.paid, 0) / 100, refunded: t.reduce((n, x) => n + x.refunded, 0) / 100, remaining: t.reduce((n, x) => n + x.remaining, 0) / 100 };
};

// Every other purchase read, and none shows the owner's problem. A normal result: nothing to plan, and what was checked stays open.
const others = (run: WhoElseRun) => run.members.filter((m) => m.incident_id !== run.seed);
export const noOtherPurchase = (run: WhoElseRun) => others(run).length > 0 && others(run).every((m) => m.bucket === 'not_same');
export const noOtherLine = (run: WhoElseRun) => `${others(run).length} checked, so there's nothing to plan.`;

// The one thing a row says. Waiting and refused are the only colours; everything else stays quiet.
const HOLD_PILL: Record<string, { label: string; tone: RowTone }> = { pending: { label: 'Waiting for approval', tone: 'attn' }, executing: { label: 'Sending to PayPal', tone: 'attn' }, completed: { label: 'Refunded', tone: 'done' }, failed: { label: 'PayPal refused', tone: 'bad' },
  unknown: { label: 'Outcome unknown', tone: 'bad' }, approved: { label: 'Approved', tone: 'quiet' }, rejected: { label: 'Rejected', tone: 'quiet' }, stale: { label: 'Not run', tone: 'bad' }, expired: { label: 'Hold expired', tone: 'bad' } };
const BUCKET_PILL: Record<Bucket, { label: string; tone: RowTone }> = { silent: { label: 'Not planned', tone: 'ready' }, complained: { label: 'Open dispute', tone: 'quiet' }, repaired: { label: 'Already repaired', tone: 'quiet' }, unclear: { label: 'Unclear', tone: 'quiet' }, not_same: { label: 'Not the same', tone: 'quiet' } };
const AGENT_PILL: Record<AgentNotice['outcome'], { label: string; tone: RowTone }> = { asked: { label: 'Agent asked', tone: 'attn' }, declined: { label: 'Agent declined', tone: 'quiet' }, failed: { label: 'Agent failed', tone: 'bad' } };
export const rowStatus = (m: Pick<Member, 'bucket' | 'sku'>, r?: Pick<Remedy, 'hold_status' | 'refund_id'>, dropped = false, n?: Pick<AgentNotice, 'outcome'>) =>
  r?.refund_id ? HOLD_PILL.completed : n?.outcome === 'asked' && r?.hold_status === 'pending' ? AGENT_PILL.asked : r?.hold_status ? HOLD_PILL[r.hold_status] ?? { label: r.hold_status, tone: 'quiet' as const }
  : n && n.outcome !== 'asked' ? AGENT_PILL[n.outcome] : dropped ? { label: 'Dropped', tone: 'quiet' as const } : m.bucket === 'not_same' && !m.sku ? { label: 'Bought nothing', tone: 'quiet' as const } : BUCKET_PILL[m.bucket];

export function whoElseRows(run: WhoElseRun, dropped: ReadonlySet<string>, closed: ReadonlySet<Bucket>, picked: string | null = null): WhoElseRow[] {
  return BUCKETS.flatMap(([bucket, name]) => {
    const members = run.members.filter((m) => m.bucket === bucket);
    if (!members.length) return [];
    const open = !closed.has(bucket);
    const group: WhoElseRow = { id: `group:${bucket}`, kind: 'group', bucket, label: `${name} (${members.length})`, open, ...totals(run, members) };
    return [group, ...(open ? members.flatMap((m): WhoElseRow[] => {
      const remedy = remedyOf(run, m), s = standing(m, remedy), silent = bucket === 'silent' && !!m.capture_id;
      const notice = noticeOf(run, m), declined = notice?.outcome === 'declined', held = !!remedy && !planAgain(remedy), isDropped = silent && dropped.has(m.capture_id!);
      const row: WhoElseRow = { id: m.incident_id, kind: 'member', bucket, label: m.incident_id, member: m, remedy, notice, can_keep: silent && !held && !declined, keep: silent && !declined && (held || !isDropped), paid: s.paid / 100, refunded: s.refunded / 100, remaining: s.remaining / 100, status: rowStatus(m, remedy, isDropped, notice) };
      return picked === m.incident_id ? [row, { ...row, id: `detail:${m.incident_id}`, kind: 'detail' }] : [row];
    }) : [])];
  });
}

// A hold that will never run: the server lets the owner plan that purchase again (DEAD in src/whoelse.ts).
const planAgain = (r: Pick<Remedy, 'hold_status'>) => ['rejected', 'expired', 'stale', 'failed'].includes(r.hold_status ?? '');
// Silent purchases the owner kept that aren't held or refunded. Works from run.members, so a collapsed group can't lose a row.
// An agent's decline takes a row out of the plan: the step doesn't push the owner to refund what the agent said it doesn't need.
export const toPlan = (run: WhoElseRun, dropped: ReadonlySet<string>) => run.members.filter((m) => { const r = remedyOf(run, m); return m.bucket === 'silent' && m.capture_id && !dropped.has(m.capture_id) && (!r || planAgain(r)) && noticeOf(run, m)?.outcome !== 'declined'; });
// The kept rows whose agent hasn't answered. A failed agent can be told again.
export const toTell = (run: WhoElseRun, dropped: ReadonlySet<string>) => toPlan(run, dropped).filter((m) => { const n = noticeOf(run, m); return !n || n.outcome === 'failed'; });
export const keptTotal = (run: WhoElseRun, dropped: ReadonlySet<string>): WhoElseRow => {
  const kept = toPlan(run, dropped);
  return { id: 'total', kind: 'total', bucket: 'silent', label: `In the plan (${kept.length})`, ...totals(run, kept) };
};

// The top of the page and the four-step path, all from the run. Nothing here reads PayPal or asks a model.
export type StepId = 'found' | 'plan' | 'approve' | 'fix';
export function whoElseSummary(run: WhoElseRun, dropped: ReadonlySet<string>) {
  const silent = run.members.filter((m) => m.bucket === 'silent'), plan = toPlan(run, dropped), held = run.remedies.filter((r) => r.hold_status === 'pending');
  const refunded = run.remedies.filter((r) => r.refund_id), failed = run.remedies.filter((r) => !r.refund_id && ['failed', 'unknown', 'stale', 'expired'].includes(r.hold_status ?? ''));
  const complained = others(run).filter((m) => m.bucket === 'complained').length, fixed = run.corrections.filter((c) => c.at), left = totals(run, silent).remaining;
  const current: StepId = held.length ? 'approve' : plan.length ? 'plan' : 'fix';
  // Done means done: a step with work left never wears a check, whichever step is current.
  const done: Record<StepId, boolean> = { found: true, plan: !plan.length && run.remedies.length > 0, approve: !plan.length && !held.length && run.remedies.length > 0, fix: fixed.length > 0 && !run.trials.some((t) => t.outcome === 'bought') };
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  const asked = run.notices.filter((x) => x.outcome === 'asked').length, declined = run.notices.filter((x) => x.outcome === 'declined').length;
  const lines: Record<StepId, string> = {
    found: `${others(run).length} others read, ${silent.length + complained} show this problem`,
    plan: `${plan.length ? `${n(plan.length, 'refund')} to plan` : `${n(run.remedies.length, 'refund')} planned`}${declined ? `, ${declined} declined` : ''}`,
    approve: held.length ? `${n(held.length, 'refund')} waiting` : [refunded.length && `${refunded.length} refunded`, failed.length && `${failed.length} not run`].filter(Boolean).join(', ') || 'Nothing to approve yet',
    fix: run.trials.length ? `${n(run.trials.length, 'trial')} run` : fixed.length ? 'Corrected' : 'Not corrected yet',
  };
  return { silent: silent.length, complained, left, refunded: refunded.length, refundedUsd: refunded.reduce((x, r) => x + cents(r.amount), 0) / 100, failed, held, plan, tell: toTell(run, dropped), asked, declined, current, done, lines };
}

// Sorting a column reorders members inside their group; a group stays in bucket order with its heading on top, and a row's detail
// stays under its row.
const bucketAt = (b: Bucket) => BUCKETS.findIndex(([k]) => k === b);
export const inGroups = (a: WhoElseRow, b: WhoElseRow) => bucketAt(a.bucket) - bucketAt(b.bucket) || Number(b.kind === 'group') - Number(a.kind === 'group');
export function detailUnderRow<N extends { data?: WhoElseRow }>(nodes: N[]) {
  const i = nodes.findIndex((n) => n.data?.kind === 'detail');
  if (i < 0) return;
  const [d] = nodes.splice(i, 1);
  nodes.splice(nodes.findIndex((n) => n.data?.id === d.data!.member!.incident_id) + 1, 0, d);
}

// The recorded text split around its quoted parts, for marking. Overlapping quotes merge; a quote not found marks nothing.
export function quoteParts(text: string, quotes: Quote[], field: QuoteField) {
  const spans = quotes.filter((q) => q.field === field).map((q) => [text.indexOf(q.text), q.text.length]).filter(([at]) => at >= 0).map(([at, n]) => [at, at + n]).sort((a, b) => a[0] - b[0]);
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  for (const [from, to] of spans) {
    if (to <= i) continue;
    if (from > i) out.push({ text: text.slice(i, from), hit: false });
    out.push({ text: text.slice(Math.max(i, from), to), hit: true });
    i = to;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

// The header's words for a failed self-check. PayPal's hosted server being down is PayPal's, and it should read that way.
export const checkWords = (failed: string[]) => (failed.length === 1 && failed[0] === "PayPal's hosted MCP server" ? "PayPal's hosted server is down" : `Self-check: ${failed.length} failing`);

// What the trials showed, said plainly when the fix didn't take. public/who-else.html words this the same way.
export function trialLines(run: WhoElseRun) {
  const fixed = run.corrections.filter((c) => c.at).map((c) => c.sku), n = run.trials.length, bought = run.trials.filter((t) => t.outcome === 'bought');
  const still = bought.filter((t) => fixed.includes(t.sku!)).length, moved = bought.filter((t) => !fixed.includes(t.sku!));
  return [still && `The agent still bought the corrected bag in ${still} of ${n}.`, moved.length && `${moved.length} of ${n} bought ${[...new Set(moved.map((t) => t.sku))].join(', ')}, and that listing hasn't been corrected.`].filter(Boolean) as string[];
}

// The Desk's saved panel layout (App.tsx saves it, Policy's Reset the layout clears it). v2: the UI polish layout;
// older saves are ignored.
export const DESK_LAYOUT_KEY = 'jd-desk-layout-v2';

export const START_OPENED_KEY = 'jd-start-opened';
export function readOpened(): string[] {
  try { const v = JSON.parse(localStorage.getItem(START_OPENED_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function markOpened(title: string) {
  try { const v = readOpened(); if (!v.includes(title)) localStorage.setItem(START_OPENED_KEY, JSON.stringify([...v, title])); } catch { /* private mode: progress isn't kept */ }
}
