// Types and fetch helpers for the desk server (src/desk.ts). Every call goes through the Vite proxy at /api.

export interface CaseRow {
  id: string; reason: string; amount: number; currency: string; status: string; stage: string;
  channel: string | null; opened: string; due: string | null; buyer_due: string | null;
  allowed: string[]; decision: Decision | null; problems: number; pending_holds: number;
  outcome: string | null; refunded: number | null; buyer_disputes: number | null;
}

export type Decision = 'message' | 'offer' | 'contest' | 'accept' | 'wait';

export interface Evidence { id: string; source: string; text: string }

export interface Claim { text: string; evidence_ids: string[] }

export interface Recommendation {
  decision: Decision; summary: string; claims: Claim[];
  offer_amount?: number; message_to_buyer?: string;
  would_change_mind?: string | null; change_reason?: string | null;
}

export interface SavedRec { recommendation: Recommendation | null; problems: string[]; at: string; previous?: { decision: string; summary: string; at: string } | null }

export interface Hold {
  id: string; status: string; method: string; reason: string; args?: any; asked_by?: string;
}

export interface Activity {
  at: string; dispute_id: string; trigger: string; step: string; detail: string;
}

export interface PlanStep { when: string; action: string; text: string; amount: string | null; status: 'waiting' | 'done' | 'failed' | 'skipped'; ran_at?: string }
export interface Plan { dispute_id: string; summary: string; steps: PlanStep[]; budget: number; status: 'proposed' | 'active' | 'finished' | 'cancelled'; approved_at?: string }

export interface CaseDetail extends CaseRow {
  evidence: Evidence[];
  saved: SavedRec | null;
  budget: { limit: number; amount: number; currency: string; set_at: string } | null;
  plan: Plan | null;
  negotiation: { status: 'active' | 'settled' | 'needs_you' | 'stopped'; bounds: { open_pct: number; ceiling_pct: number; max_rounds: number }; rounds: { at: string; offered: number; message: string }[]; note?: string } | null;
  holds: Hold[];
  activity: Activity[];
}

export async function api<T = any>(path: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = opts;
  const r = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error?.message ?? r.statusText), { body });
  return body as T;
}

export const TRIGGER: Record<string, string> = {
  sweep: 'scheduled check',
  owner: 'you',
  mcp: 'MCP client',
  assistant: 'dashboard assistant',
  'PAYMENT.CAPTURE.COMPLETED': 'PayPal: payment captured',
  check: 'manual check', // rows written by older local runs
  'CUSTOMER.DISPUTE.CREATED': 'PayPal: new dispute',
  'CUSTOMER.DISPUTE.UPDATED': 'PayPal: dispute updated',
  'CUSTOMER.DISPUTE.RESOLVED': 'PayPal: resolved',
};

export const REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorized',
  CREDIT_NOT_PROCESSED: 'Credit not processed',
  DUPLICATE_TRANSACTION: 'Duplicate',
  INCORRECT_AMOUNT: 'Incorrect amount',
};

export const STATUS: Record<string, string> = {
  WAITING_FOR_BUYER_RESPONSE: "Buyer's turn",
  WAITING_FOR_SELLER_RESPONSE: 'Your turn',
  UNDER_REVIEW: 'PayPal reviewing',
  OPEN: 'Open',
  RESOLVED: 'Resolved',
  OTHER: 'Other',
};

export const DECISION_LABEL: Record<Decision, string> = {
  message: 'Message buyer', offer: 'Offer refund', contest: 'Contest', accept: 'Accept', wait: 'Wait',
};

export const ACTION_LABEL: Partial<Record<Decision, string>> = {
  message: 'Send message', offer: 'Make offer', contest: 'Submit to PayPal', accept: 'Accept and refund',
};

export const money = (n: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);

export const human = (s: unknown) => String(s ?? '').toLowerCase().replace(/_/g, ' ');

export const daysLeft = (iso: string | null) =>
  iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5) : null;

export function dueText(due: string | null): string {
  const d = daysLeft(due);
  if (d === null) return 'Not yet';
  if (d < 0) return 'Overdue';
  if (d === 0) return 'Due today';
  return `${d} day${d === 1 ? '' : 's'}`;
}

export const actKey = (a: Activity) => `${a.at}|${a.dispute_id}|${a.step}`;
