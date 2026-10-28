// Small UI rules shared by the desk widgets, kept free of React so check-ui can pin them.
import { human } from './api';

// Waiting for your OK: pending holds only. Approved holds PayPal hasn't confirmed are shown apart; the rest are finished.
const UNCONFIRMED = new Set(['executing', 'unknown', 'failed']);
export function splitHolds<H extends { status: string }>(holds: H[]) {
  return { pending: holds.filter((h) => h.status === 'pending'), unconfirmed: holds.filter((h) => UNCONFIRMED.has(h.status)) };
}

const APPROVE: Record<string, string> = { create_refund: 'Approve refund', make_dispute_offer: 'Approve offer', accept_dispute_claim: 'Approve claim acceptance', provide_dispute_evidence: 'Approve evidence' };
export const approveLabel = (method: string) => APPROVE[method] ?? `Approve ${human(method)}`;

// Start here: the current step is the first this browser hasn't opened (the last once all are); done counts opened steps.
export function startProgress(opened: string[], titles: string[]) {
  const i = titles.findIndex((t) => !opened.includes(t));
  return { current: i < 0 ? titles.length - 1 : i, done: titles.filter((t) => opened.includes(t)).length };
}

export const START_OPENED_KEY = 'jd-start-opened';
export function readOpened(): string[] {
  try { const v = JSON.parse(localStorage.getItem(START_OPENED_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function markOpened(title: string) {
  try { const v = readOpened(); if (!v.includes(title)) localStorage.setItem(START_OPENED_KEY, JSON.stringify([...v, title])); } catch { /* private mode: progress isn't kept */ }
}
