// Small UI rules shared by the desk widgets, kept free of React so check-ui can pin them.
import { human } from './api';
import type { Bucket, Member, Quote, QuoteField, Remedy, WhoElseRun } from '../../src/whoelse-types';

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
export type WhoElseRow = { id: string; kind: 'group' | 'member' | 'total'; bucket: Bucket; label: string; open?: boolean; keep?: boolean; can_keep?: boolean; paid: number; refunded: number; remaining: number; member?: Member; remedy?: Remedy };
const cents = (s: string) => Math.round(Number(s) * 100);
const sum = (rows: Member[], f: (m: Member) => string) => rows.reduce((n, m) => n + cents(f(m)), 0) / 100;

// Every other purchase read, and none shows the owner's problem. A normal result: nothing to plan, and what was checked stays open.
const others = (run: WhoElseRun) => run.members.filter((m) => m.incident_id !== run.seed);
export const noOtherPurchase = (run: WhoElseRun) => others(run).length > 0 && others(run).every((m) => m.bucket === 'not_same');
export const noOtherLine = (run: WhoElseRun) => `${others(run).length} checked, so there's nothing to plan.`;

export function whoElseRows(run: WhoElseRun, dropped: ReadonlySet<string>, closed: ReadonlySet<Bucket>): WhoElseRow[] {
  return BUCKETS.flatMap(([bucket, name]) => {
    const members = run.members.filter((m) => m.bucket === bucket);
    if (!members.length) return [];
    const open = !closed.has(bucket);
    const group: WhoElseRow = { id: `group:${bucket}`, kind: 'group', bucket, label: `${name} (${members.length})`, open, paid: sum(members, (m) => m.paid), refunded: sum(members, (m) => m.refunded), remaining: sum(members, (m) => m.remaining) };
    return [group, ...(open ? members.map((m): WhoElseRow => {
      const remedy = run.remedies.find((r) => r.capture_id === m.capture_id);
      const silent = bucket === 'silent' && !!m.capture_id;
      return { id: m.incident_id, kind: 'member', bucket, label: m.incident_id, member: m, remedy, can_keep: silent && !remedy, keep: silent && (!!remedy || !dropped.has(m.capture_id!)), paid: cents(m.paid) / 100, refunded: cents(m.refunded) / 100, remaining: cents(m.remaining) / 100 };
    }) : [])];
  });
}

// Silent purchases the owner kept that have no hold yet. Works from run.members, so a collapsed group can't lose a row.
export const toPlan = (run: WhoElseRun, dropped: ReadonlySet<string>) => run.members.filter((m) => m.bucket === 'silent' && m.capture_id && !dropped.has(m.capture_id) && !run.remedies.some((r) => r.capture_id === m.capture_id));
export const keptTotal = (run: WhoElseRun, dropped: ReadonlySet<string>): WhoElseRow => {
  const kept = run.members.filter((m) => m.bucket === 'silent' && m.capture_id && !dropped.has(m.capture_id));
  return { id: 'total', kind: 'total', bucket: 'silent', label: `Kept for the plan (${kept.length})`, paid: sum(kept, (m) => m.paid), refunded: sum(kept, (m) => m.refunded), remaining: sum(kept, (m) => m.remaining) };
};

// Sorting a column reorders members inside their group; a group stays in bucket order with its heading on top.
const bucketAt = (b: Bucket) => BUCKETS.findIndex(([k]) => k === b);
export const inGroups = (a: WhoElseRow, b: WhoElseRow) => bucketAt(a.bucket) - bucketAt(b.bucket) || Number(b.kind === 'group') - Number(a.kind === 'group');

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
