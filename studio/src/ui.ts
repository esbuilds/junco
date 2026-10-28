// Small UI rules shared by the desk widgets, kept free of React so check-ui can pin them.
import { human } from './api';

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

const APPROVE: Record<string, string> = { create_refund: 'Approve refund', make_dispute_offer: 'Approve offer', accept_dispute_claim: 'Approve claim acceptance', provide_dispute_evidence: 'Approve evidence' };
export const approveLabel = (method: string) => APPROVE[method] ?? `Approve ${human(method)}`;

// Start here: the current step is the first this browser hasn't opened (the last once all are); done counts opened steps.
export function startProgress(opened: string[], titles: string[]) {
  const i = titles.findIndex((t) => !opened.includes(t));
  return { current: i < 0 ? titles.length - 1 : i, done: titles.filter((t) => opened.includes(t)).length };
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
