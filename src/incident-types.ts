// BLACK BOX (Oct 28): one AI purchase's whole story, joined from records the desk already keeps (pool, store runs, holds,
// gate log, agent activity, webhook re-checks). Nothing in it comes from a model. Shared by src/incident.ts (the join and
// the what-if), the connector tools, the desk's incident page and the Studio view: import these, never redefine them.

// LIVE: happened against PayPal's sandbox. RECORDED: read back from the desk's records. WHAT-IF: the gate re-run on a
// recorded request under a changed rule; it never reaches PayPal.
export type Mode = 'live' | 'recorded' | 'what-if';

// decline: the shopping agent chose to buy nothing (RECORDED; nothing reached PayPal). paypal_fingerprint: PayPal's copy of
// the mandate fingerprint on the order, read back at capture and checked against the store's record (src/fingerprint.ts).
// reconciliation: PayPal's refunds on the capture lined up against the desk's holds (src/reconcile.ts), LIVE when PayPal answered.
// outside_refund: PayPal's webhook reported a refund the desk didn't make (the drill, or anyone working in PayPal directly).
export type EventKind = 'purchase' | 'decline' | 'payment' | 'dispute' | 'agent' | 'gate' | 'hold' | 'approval' | 'paypal' | 'webhook' | 'paypal_fingerprint' | 'reconciliation' | 'outside_refund';

// What a reconciliation line found. matched, dispute_hold and settled are not differences; paypal_only and desk_only are;
// unread means PayPal didn't answer, so nothing is known either way. fingerprint_mismatch is the one on a fingerprint event.
export type Match = 'matched' | 'dispute_hold' | 'settled' | 'paypal_only' | 'desk_only' | 'unread' | 'fingerprint_mismatch';

export type IncidentEvent = {
  id: string;        // stable across reads: `${kind}:${record id}`, e.g. 'hold:3f2a', 'gate:2026-10-28T12:00:00.000Z'
  at: string;        // ISO time from the record
  kind: EventKind;
  mode: Exclude<Mode, 'what-if'>; // live: PayPal acted (purchase, dispute opened, PayPal's answer, its webhooks, a gate allow that
                     // went straight to PayPal); recorded: the desk's own records (agent steps, holds, approvals, denials, leases)
  actor: string;     // 'shopping agent', 'JUNCO agent', 'Claude (connector)', 'gate', 'owner', 'PayPal', 'buyer'
  summary: string;   // one plain sentence a judge can read
  source: string;    // the record it came from: 'pool', 'store-runs', 'holds', 'gate-log', 'activity', 'PayPal'
  ref?: Partial<Record<'order_id' | 'capture_id' | 'buyer_txn' | 'dispute_id' | 'hold_id' | 'refund_id' | 'run_id' | 'rule', string>>;
  match?: Match;     // reconciliation lines about one money movement, and a failed read
};

// One purchase side by side (threeRecords in incident-questions.ts), from the incident alone: no model, no extra PayPal read.
// A column is what was recorded or what PayPal answers, so WHAT-IF can never be one.
export type ThreeRecords = {
  agree: boolean | null; // null: PayPal wasn't read, so nothing can be compared
  line: string;          // one plain sentence: they agree, or how they differ
  columns: { title: string; mode: Exclude<Mode, 'what-if'>; rows: { label: string; value: string }[] }[];
};

export type Incident = {
  id: string;        // the buyer transaction id, the pool's key; a decline's is 'decline-<time>' (never 17 uppercase chars)
  title: string;     // e.g. 'Agent bought WKD-01 for "waterproof bag for kayaking"'
  authority: { instruction: string; budget: string; agent: string } | null;          // what the buyer allowed
  purchase: { sku: string; listing: string; reason: string; amount: string; order_id?: string; capture_id?: string } | null;
  // Set only when the agent bought nothing: its reason and the listings it saw. purchase is then null and counts are all 0.
  decline?: { reason: string; listings: string[] };
  // Only on a desk visitor's own agent buy: whether this viewer may ask the support agent for a refund (their own purchase,
  // signed in, not asked yet), and the ask if there is one, with its hold's state now (expired once 24 h pass undecided).
  refund?: { can_ask: boolean; ask: { at: string; reason: string; outcome: 'asking' | 'held' | 'no refund' | 'failed'; ai: string | null;
    hold_id: string | null; hold_status: string | null; expires: string | null } | null };
  dispute_id: string | null;
  events: IncidentEvent[];                                                            // oldest first
  counts: { proposed: number; approved: number; executed: number; outcome_unknown: number }; // money moves only
  missing: string[]; // facts the records don't have, said plainly; never filled in by a model
  records?: ThreeRecords | null; // the desk's incident JSON only; null on a decline. Connector tools don't carry it
};

export type IncidentSummary = Pick<Incident, 'id' | 'title' | 'dispute_id' | 'counts'> & { last_at: string };

export type WhatIf = {
  mode: 'what-if';
  event_id: string;  // the recorded request it re-ran
  method: string;
  args: unknown;
  change: string;    // the one rule change, in words: 'refund limit 50 -> 30 USD'
  before: { verdict: string; reason: string };
  after: { verdict: string; reason: string };
  paypal_calls: 0;   // by construction: the what-if path has no PayPal client
};
