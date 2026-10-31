// Types and fetch helpers for the desk server (src/desk.ts). Every call goes through the Vite proxy at /api.

export interface CaseRow {
  id: string; reason: string; amount: number; currency: string; status: string; stage: string;
  channel: string | null; opened: string; due: string | null; buyer_due: string | null;
  allowed: string[]; decision: Decision | null; problems: number; pending_holds: number;
  outcome: string | null; refunded: number | null; buyer_disputes: number | null;
}

export type Decision = 'message' | 'offer' | 'contest' | 'accept' | 'wait';

export interface Evidence { id: string; source: string; text: string; quotable?: boolean }

export interface Claim { text: string; evidence_ids: string[]; quote?: string | null; support?: 'supported' | 'not supported' | 'unconfirmed'; support_reason?: string }
// v3.14 item 4: a second model read only the cited items. Recommendations from before Oct 14 carry no verdict.
export const SUPPORT_NOTE: Record<string, string> = { supported: 'Support checked: a second model read only the cited items and found they say this.', 'not supported': 'Not supported by the cited items; this blocked the recommendation.', unconfirmed: 'Cited, support not confirmed.' };

// What the desk shows under a claim. Source-text items: the quote and where it was found word for word (same rule as
// validate() on the server), never "verified". Everything else: the cited item as JUNCO rendered it from PayPal's or
// the carrier's fields, so facts like amounts, dates and tracking status don't rest on the model's sentence.
const norm = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim();
export function whereFrom(e: Evidence, evidence: Evidence[]): string {
  if (e.source.startsWith('paypal message')) {
    const n = evidence.filter((x) => x.source.startsWith('paypal message')).indexOf(e) + 1;
    return `${e.source.endsWith('buyer') ? 'buyer' : 'seller'} message ${n}`;
  }
  if (e.source.startsWith('paypal note')) return e.source.includes('buyer') ? `the buyer's note filed with the case (${e.id})` : `the seller's note on file (${e.id})`;
  return `${e.source} (${e.id})`;
}
export function claimSupport(c: Claim, evidence: Evidence[]) {
  const cited = evidence.filter((e) => c.evidence_ids.includes(e.id));
  const hit = c.quote && norm(c.quote).length >= 8 ? cited.find((e) => e.quotable && norm(e.text).includes(norm(c.quote!))) : undefined;
  return {
    quote: hit ? { text: c.quote!, where: whereFrom(hit, evidence) } : null,
    unquoted: !hit && cited.some((e) => e.quotable), // cites someone's words without quoting them (v3.12 call 5)
    facts: cited.filter((e) => !e.quotable).map((e) => ({ id: e.id, from: e.source.startsWith('paypal') ? 'PayPal' : e.source.replace(/ tracking \(carrier API\)$/, ''), text: e.text })),
  };
}
export const QUOTE_NOTE = "A found quote confirms the text exists; the interpretation is the AI's.";
export const UNQUOTED_NOTE = 'Cited, not quoted: the evidence item exists; no quote was checked.';

export interface Recommendation {
  decision: Decision; summary: string; claims: Claim[];
  offer_amount?: number; message_to_buyer?: string;
  would_change_mind?: string | null; change_reason?: string | null;
}

export interface SavedRec { recommendation: Recommendation | null; problems: string[]; at: string; previous?: { decision: string; summary: string; at: string } | null }

export interface Hold {
  id: string; status: string; method: string; reason: string; args?: any; asked_by?: string; paypal?: { id: string; status: string | null } | null; recheck?: { at: string; event: string; refund?: { id: string; at: string } };
  full_refund?: string; // a refund with no amount: "Full refund of $38.00" (or "Full refund" when the amount isn't on record)
  decided_by?: string; // only when it wasn't the owner: a visitor on their leased case
}
// T2: an approved hold isn't done until PayPal says so. Same wording as the case file.
export const HOLD_STATUS: Record<string, string> = { pending: 'waiting for you', executing: 'approved, sending to PayPal now', completed: 'approved, and PayPal confirmed it ran', failed: 'approved, but PayPal refused it', unknown: 'approved, outcome unknown until PayPal is re-read', approved: 'approved (outcome not recorded)', rejected: 'rejected by owner', stale: 'approved but not run, the case had changed', expired: "expired: the owner didn't decide within 24 hours, nothing sent" };

// A hold's status in words. A rejection names who rejected it when that wasn't the owner.
export const holdWords = (h: Pick<Hold, 'status' | 'decided_by'>) => (h.status === 'rejected' && h.decided_by ? `rejected by ${h.decided_by}` : HOLD_STATUS[h.status] ?? h.status);

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
  incident: string | null; // BLACK BOX: the AI purchase this dispute came from, if any
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
