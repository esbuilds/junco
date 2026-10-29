// M1 "Dispute this store": a visitor gets a real sandbox dispute against the demo store and watches JUNCO work it.
// PayPal's buyer-side API needs the BUYER's transaction ID for a paid order, which only the buyer's Activity page shows,
// so paid orders are prepared ahead into a pool (src/pool.ts). PayPal's sandbox opens API-filed disputes either as an
// ordinary inquiry (PP-R-GJF, Oct 10) or as a chargeback under review (AAU, OEM, SCP, LQC), and takes about five minutes to unlock merchant actions (Oct 10), so cases are filed ahead
// into a ready set (STRATEGY v3.12): a visitor leases one that is already unlocked and JUNCO starts on it at once.
// Two kinds: an order never shipped (JUNCO holds an accept for the visitor) and an order with a delivery record entered
// by this demo store (JUNCO sends supporting info). PayPal itself never says "delivered" for a sandbox order.
// A third kind (v3.15 move 1): an order a shopping agent placed for the buyer, paying with a PayPal account the buyer saved
// for this store (Orders v2 with a vault_id, merchant-initiated), disputed by the buyer as not as described. The store's
// record of that agent checkout (what the agent was asked, the listing it bought, the reason it gave) is evidence. It is
// the store's own record, not a PayPal-signed mandate.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mirror } from './persist.js';
import type { Ctx } from './disputes.js';

export type Kind = 'unshipped' | 'delivered' | 'agent';
export const KINDS: Kind[] = ['unshipped', 'delivered', 'agent'];
// capture_id: the payment's capture (refunds name it); paid_at: when PayPal captured it. Recorded from Oct 28 on (paid_at
// from Oct 28); older entries lack them until backfilled.
export type AgentRecord = { instruction: string; budget: string; sku: string; listing: string; reason: string; agent: string; capture_id?: string; paid_at?: string };
export type PoolEntry = { buyer_txn: string; amount: string; order_id?: string; tracking?: boolean; scan?: string; agent?: AgentRecord; added: string };
// A run is one filed case. visitor/session/leased_at are set when a visitor leases it; unlocked_at when PayPal first
// lists merchant actions; retired_at when it aged out of the ready set unleased.
export type Run = { at: string; visitor: string; session?: string; buyer_txn: string; kind?: Kind; scan?: string; dispute_id?: string; error?: string; challenge?: boolean;
  unlocked_at?: string; leased_at?: string; retired_at?: string };
// A shopping agent that bought nothing (pool.ts agent): what it was asked, why it declined, the listings it saw. No order,
// so it never enters the pool (the pool feeds dispute filing). id: 'decline-' and the agent's time, digits only.
// session: set when a desk visitor sent the agent (/api/shop); only that session and the owner see it in the list.
export type Decline = { id: string; at: string; instruction: string; budget: string; reason: string; agent: string; listings: string[]; added: string; session?: string };
// "Your AI buys, you investigate": an order the desk placed for a visitor's shopping agent on the saved PayPal account.
// The desk can't read the buyer's PayPal activity, so there is no buyer transaction id: the capture id keys it, and it
// can't be disputed (filing needs that id), only refunded. Never in the pool.
export type AgentBuy = { capture_id: string; order_id: string; amount: string; agent: AgentRecord; session: string; added: string };
const POOL = '.junco/pool.json', RUNS = '.junco/store-runs.json', DECLINES = '.junco/declines.json', BUYS = '.junco/agent-buys.json', TRIES = '.junco/shop-tries.json';
const read = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f: string, v: unknown) => { mkdirSync('.junco', { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2)); mirror(f, v); };
export const readPool = () => read<PoolEntry[]>(POOL, []);
export const readRuns = () => read<Run[]>(RUNS, []);
export const readDeclines = () => read<Decline[]>(DECLINES, []);
export const readAgentBuys = () => read<AgentBuy[]>(BUYS, []);
export const addAgentBuy = (b: AgentBuy) => write(BUYS, [...readAgentBuys(), b]);
// Every /api/shop attempt that reaches Claude, kept for the caps (a refused or failed charge still cost a call).
type Try = { at: string; session: string };
export const readShopTries = () => read<Try[]>(TRIES, []);
export const addShopTry = (session: string) => write(TRIES, [...readShopTries(), { at: new Date().toISOString(), session }]);
export const declineId = (at: string) => `decline-${at.replace(/\D/g, '')}`;
const used = () => new Set(readRuns().map((r) => r.buyer_txn));
// Tracked orders without a delivery record (the first M1 pool) are neither kind and stay unused.
const kindOf = (p: PoolEntry): Kind | null => (p.agent ? 'agent' : !p.tracking ? 'unshipped' : p.scan ? 'delivered' : null);
const unused = (kind: Kind) => readPool().filter((p) => kindOf(p) === kind && !used().has(p.buyer_txn));

// Cases must look their age (Oct 10: a same-day order made JUNCO say "too early to expect delivery", and a delivery
// record timed at the minute of payment was rightly called implausible). A never-shipped order is offered once it's past
// the store's 2-day ship-by window; a delivered one once its record (44 hours after payment) is in the past. Payment
// time is when the pool entry was added (the filler adds it minutes after paying).
const DAY = 24 * 3600_000;
const MIN_AGE: Record<Kind, number> = { unshipped: 3 * DAY, delivered: 2 * DAY, agent: 2 * DAY };
const DELIVERED_AFTER = 44 * 3600_000;
const paidAt = (buyer_txn: string) => Date.parse(readPool().find((p) => p.buyer_txn === buyer_txn)?.added ?? '') || 0;
const oldEnough = (kind: Kind, buyer_txn: string) => Date.now() - paidAt(buyer_txn) >= MIN_AGE[kind];
// Filed as soon as they're in the pool: the age rule applies when Dispute this store offers a case (ready), and the
// challenge doesn't need an aged order. Retirement counts from when a case becomes offerable.
const fileable = (kind: Kind) => unused(kind);

// Never-shipped cases also serve Break the mandate (v3.12 update 2 ruling 3), so more of them are kept ready.
export const READY_PER_KIND: Record<Kind, number> = { unshipped: Number(process.env.STORE_READY_UNSHIPPED ?? 4), delivered: Number(process.env.STORE_READY_DELIVERED ?? 2), agent: Number(process.env.STORE_READY_AGENT ?? 2) };
export const RETIRE_MS = 3 * DAY; // after a case becomes offerable; a judge must never get one whose window is closing
const waiting = (r: Run) => !!r.dispute_id && !r.leased_at && !r.retired_at;
export const ready = (kind: Kind) => readRuns().filter((r) => r.kind === kind && waiting(r) && r.unlocked_at && oldEnough(kind, r.buyer_txn));
// Pre-filed cases waiting for a judge: the agent leaves them alone until leased (or retired).
export const isWaiting = (id: string) => readRuns().some((r) => r.dispute_id === id && waiting(r));
// The demo store's own delivery record for a delivered case, as a merchant record on the case's evidence.
export const extraFor = (id: string) => {
  const run = readRuns().find((r) => r.dispute_id === id);
  if (!run) return [];
  const at = new Date(paidAt(run.buyer_txn) + DELIVERED_AFTER).toISOString().slice(0, 16).replace('T', ' ');
  const scan = run.scan ? [{ source: 'carrier delivery scan (entered by merchant)', text: `${run.scan.replace(/, \d{4}-\d\d-\d\d \d\d:\d\d UTC$/, '')}, ${at} UTC` }] : [];
  const a = readPool().find((p) => p.buyer_txn === run.buyer_txn)?.agent;
  if (!a) return scan;
  const paid = new Date(paidAt(run.buyer_txn)).toISOString().slice(0, 16).replace('T', ' ');
  return [
    { source: 'agent checkout record (kept by merchant)', text: `Placed ${paid} UTC through the store's agent checkout by ${a.agent}, acting for the buyer, paid with a PayPal account the buyer saved for this store. Instruction the agent sent with the order: "${a.instruction}" Budget given: $${a.budget}.` },
    { source: 'product listing at time of order (merchant)', text: a.listing },
    { source: "agent's stated reason for the purchase (kept by merchant)", text: a.reason },
    ...scan,
  ];
};
// What the store holds for a case, for every path that asks Claude about it (the agent, Get recommendation, plans): the
// pool record above plus a delivery scan the owner typed in. Oct 28: Get recommendation sent only the typed scan, so on an
// agent purchase JUNCO said "nothing on file shows the listing".
export const merchantRecords = (id: string, typedScan?: unknown) =>
  [...extraFor(id), ...(typedScan ? [{ source: 'carrier delivery scan (entered by merchant)', text: String(typedScan).slice(0, 500) }] : [])];
// Filed cases still waiting (unlocking or aging) count too: they will be offered.
export const liveLeft = (kind: Kind) => readRuns().filter((r) => r.kind === kind && waiting(r)).length + unused(kind).length;

// The recorded run the panel shows (v3.12 update R3): pinned by the owner, else the newest aged run (one leased once its
// order was old enough), else the newest leased run. A pin can be set to last only until an aged run exists.
const PIN = '.junco/store-pin.json';
type Pin = { dispute_id: string; until_aged: boolean } | null;
export const readPin = () => read<Pin>(PIN, null);
export const setPin = (p: Pin) => write(PIN, p);
const aged = (r: Run) => !!r.kind && !!r.leased_at && Date.parse(r.leased_at) - paidAt(r.buyer_txn) >= MIN_AGE[r.kind];
export function recordedRun(): Run | null {
  const runs = readRuns().filter((r) => r.dispute_id && (r.leased_at || r.visitor !== 'system'));
  const newestAged = runs.filter(aged).at(-1) ?? null, pin = readPin();
  const pinned = pin && !(pin.until_aged && newestAged) ? runs.find((r) => r.dispute_id === pin.dispute_id) : undefined;
  return pinned ?? newestAged ?? runs.at(-1) ?? null;
}

// Owner adds prepared orders. Entries already in the pool are skipped, except that an agent record missing its capture_id
// or paid_at takes it from the post (entries filled before those were recorded); nothing else on an existing entry changes.
const captureOf = (e: any): string | undefined => (typeof e?.agent?.capture_id === 'string' && /^\w{1,40}$/.test(e.agent.capture_id) ? e.agent.capture_id : undefined);
// ISO UTC only (PayPal's create_time or toISOString), stored normalized so it sorts as text with the desk's other times.
const paidOf = (e: any): string | undefined => {
  const t = e?.agent?.paid_at;
  return typeof t === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(t) && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined;
};
export function addToPool(entries: any[]): { added: number; backfilled: number } {
  const pool = readPool(), have = new Set(pool.map((p) => p.buyer_txn));
  let backfilled = 0;
  for (const e of entries) {
    const p = pool.find((x) => x.buyer_txn === e?.buyer_txn), c = captureOf(e), t = paidOf(e);
    if (!p?.agent || !((!p.agent.capture_id && c) || (!p.agent.paid_at && t))) continue;
    if (!p.agent.capture_id && c) p.agent.capture_id = c;
    if (!p.agent.paid_at && t) p.agent.paid_at = t;
    backfilled++; // entries, not fields
  }
  const fresh = entries
    .filter((e) => typeof e?.buyer_txn === 'string' && /^[A-Z0-9]{17}$/.test(e.buyer_txn) && !have.has(e.buyer_txn) && Number(e.amount) > 0)
    .map((e) => ({ buyer_txn: e.buyer_txn, amount: Number(e.amount).toFixed(2), order_id: e.order_id, tracking: !!e.tracking,
      ...(typeof e.scan === 'string' && (e.tracking || e.agent) && { scan: e.scan.slice(0, 500) }),
      ...(e.agent && { agent: { ...Object.fromEntries(['instruction', 'budget', 'sku', 'listing', 'reason', 'agent'].map((k) => [k, String(e.agent[k] ?? '').slice(0, 1000)])),
        ...(captureOf(e) && { capture_id: captureOf(e) }), ...(paidOf(e) && { paid_at: paidOf(e) }) } as AgentRecord }),
      added: new Date().toISOString() }));
  if (fresh.length || backfilled) write(POOL, [...pool, ...fresh]);
  return { added: fresh.length, backfilled };
}
// Same owner-token post as the pool. The id comes from the agent's own time, so a re-post adds nothing.
export function addDeclines(list: any[], session?: string): number {
  const have = readDeclines(), ids = new Set(have.map((d) => d.id)), s = (v: unknown) => String(v ?? '').slice(0, 1000);
  const fresh: Decline[] = [];
  for (const d of list) {
    const at = typeof d?.at === 'string' && !Number.isNaN(Date.parse(d.at)) ? new Date(d.at).toISOString() : null;
    const id = at && declineId(at);
    if (!id || ids.has(id) || !s(d.instruction) || !s(d.reason)) continue;
    ids.add(id);
    fresh.push({ id, at: at!, instruction: s(d.instruction), budget: s(d.budget), reason: s(d.reason), agent: s(d.agent),
      listings: Array.isArray(d.listings) ? d.listings.slice(0, 20).map(s) : [], added: new Date().toISOString(), ...(session && { session }) });
  }
  if (fresh.length) write(DECLINES, [...have, ...fresh]);
  return fresh.length;
}

// D1 leases. A leased case belongs to the session that leased it for 30 minutes from the lease; after that it's a past
// run, read-only to visitors. Who's asking comes from the desk request: visitors are a cookie session behind the shared
// password, the owner has the owner cookie, and anything outside a desk request (PayPal webhooks, timers) is the system.
export type Actor = { owner: boolean; session: string };
export const actor = new AsyncLocalStorage<Actor>();
export const LEASE_MS = 30 * 60_000;
export const leaseUntil = (r: Run) => Date.parse(r.leased_at ?? r.at) + LEASE_MS;
const holdsLease = (a: Actor, run?: Run) => !!run && run.session === a.session && leaseUntil(run) >= Date.now();
// Writes on pool cases: only the visitor holding the lease (v3.11 ruling 2).
export function leaseRefusal(disputeId?: string): string | null {
  const a = actor.getStore();
  if (!a || a.owner || !disputeId) return null;
  const run = readRuns().find((r) => r.dispute_id === disputeId);
  if (!run) return null; // not a pool case
  if (run.session === a.session && !holdsLease(a, run)) return 'this live run has ended; past runs are read-only';
  if (!holdsLease(a, run)) return 'case leased to another visitor';
  return null;
}
// Approving or rejecting a hold: visitors only on the case they hold; shared cases are the owner's (v3.12 call 1).
export function decideRefusal(disputeId?: string): string | null {
  const a = actor.getStore();
  if (!a || a.owner) return null;
  const run = readRuns().find((r) => r.dispute_id === disputeId);
  // In Break the mandate the visitor plays the buyer: a concession they talked JUNCO into waits for the owner, not them.
  if (run?.challenge) return 'holds from Break the mandate are approved or rejected only by the owner';
  if (holdsLease(a, run)) return null;
  return run ? leaseRefusal(disputeId) ?? 'case leased to another visitor'
    : 'only the owner approves or rejects on shared demo cases; use Dispute this store to get a case of your own';
}

// One case of each kind per visitor per day; the ready set and the pool are the overall cap (v3.9 ruling 10).
const PER_VISITOR = Number(process.env.STORE_DISPUTES_PER_VISITOR ?? 1);
export function refusal(visitor: string, kind: Kind): string | null {
  if (!process.env.SANDBOX_BUYER_EMAIL) return 'Live runs are not set up on this desk (no sandbox buyer configured).';
  const today = new Date().toISOString().slice(0, 10);
  if (readRuns().filter((r) => r.visitor === visitor && r.kind === kind && !r.challenge && r.leased_at?.startsWith(today)).length >= PER_VISITOR)
    return 'One case of each kind per visitor a day. Yours is below.';
  if (!ready(kind).length) return fileable(kind).length || readRuns().some((r) => r.kind === kind && waiting(r) && oldEnough(kind, r.buyer_txn))
    ? 'No case of this kind is ready right now. A new one is being filed; PayPal takes about five minutes to open it.'
    : unused(kind).length || readRuns().some((r) => r.kind === kind && waiting(r))
      ? 'No case of this kind is ready yet: the next order is too recent to be overdue. The recorded run below shows an earlier one.'
      : 'No live cases of this kind left right now. The recorded run below shows an earlier one.';
  return null;
}

// Lease the oldest ready case of a kind to this visitor. The caller starts JUNCO on it.
export function lease(visitor: string, session: string | undefined, kind: Kind): Run {
  const why = refusal(visitor, kind);
  if (why) throw Object.assign(new Error(why), { code: 400 });
  const runs = readRuns();
  const r = runs.filter((x) => x.kind === kind && waiting(x) && x.unlocked_at).sort((a, b) => a.at.localeCompare(b.at))[0];
  Object.assign(r, { visitor, session, leased_at: new Date().toISOString() });
  write(RUNS, runs);
  return r;
}

// Break the mandate: the visitor's paired case, a never-shipped INQUIRY from the ready set (the seller can message and
// offer there, so JUNCO's writes are real). Order age doesn't matter here, so the youngest unlocked case goes first and
// the aged ones stay for Dispute this store. A live lease is reused for every message in the session.
export const isChallenge = (id: string) => readRuns().some((r) => r.dispute_id === id && r.challenge);
const CASES_PER_VISITOR = Number(process.env.CHALLENGE_CASES_PER_VISITOR ?? 1);
export function challengeCase(visitor: string, session: string, owner = false): Run {
  const runs = readRuns(), now = Date.now();
  const mine = runs.filter((r) => r.challenge && r.session === session && leaseUntil(r) > now).at(-1);
  if (mine) return mine;
  if (!process.env.SANDBOX_BUYER_EMAIL) throw Object.assign(new Error('The challenge is not set up on this desk (no sandbox buyer configured).'), { code: 400 });
  const today = new Date().toISOString().slice(0, 10);
  if (!owner && runs.filter((r) => r.challenge && r.visitor === visitor && r.leased_at?.startsWith(today)).length >= CASES_PER_VISITOR)
    throw Object.assign(new Error('One challenge case per visitor a day; your earlier runs and their pages are below.'), { code: 400 });
  const r = runs.filter((x) => x.kind === 'unshipped' && waiting(x) && x.unlocked_at).sort((a, b) => paidAt(b.buyer_txn) - paidAt(a.buyer_txn))[0];
  if (!r) throw Object.assign(new Error('No case is ready for the challenge right now. A new one is being filed; PayPal takes about five minutes to open it.'), { code: 400 });
  Object.assign(r, { visitor, session, leased_at: new Date().toISOString(), challenge: true });
  write(RUNS, runs);
  return r;
}

// The app acts as the sandbox buyer after a one-time consent: PayPal-Auth-Assertion names the buyer, the bearer is ours.
const assertion = (email: string) => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: process.env.PAYPAL_CLIENT_ID ?? process.env.client_id, email })}.`;
};

// File one pool order of a kind as a dispute, as the sandbox buyer. The system does this ahead of any visitor.
export async function fileOne(ctx: Ctx, kind: Kind): Promise<Run> {
  const entry = fileable(kind)[0];
  if (!entry) throw new Error(`No ${kind} pool orders left`);
  const run: Run = { at: new Date().toISOString(), visitor: 'system', buyer_txn: entry.buyer_txn, kind, ...(entry.scan && { scan: entry.scan }) };
  write(RUNS, [...readRuns(), run]); // claim the pool entry before calling PayPal, so two timers can't use it twice
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify({
    disputed_transactions: [{ buyer_transaction_id: entry.buyer_txn }],
    reason: kind === 'agent' ? 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' : 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    dispute_amount: { currency_code: 'USD', value: entry.amount },
    // Agent orders: the buyer says the item was different from what they expected. PayPal's sandbox keeps the sub-reason
    // on API-filed disputes but drops a description (Oct 15, PP-R-ZBL), so no buyer words are sent.
    extensions: { merchant_contacted: false, merchandize_dispute_properties: { issue_type: 'PRODUCT', ...(kind === 'agent' && { product_details: { sub_reasons: ['DIFFERENT'] } }) } },
  })], { type: 'application/json' }));
  const r = await fetch(`${ctx.baseUrl}/v1/customer/disputes`, {
    method: 'POST', body: form,
    headers: { Authorization: `Bearer ${await ctx.token()}`, 'PayPal-Auth-Assertion': assertion(process.env.SANDBOX_BUYER_EMAIL!) },
  });
  const body: any = await r.json().catch(() => ({}));
  const href: string | undefined = body.links?.find((l: any) => /\/disputes\/PP-/.test(l.href))?.href;
  const runs = readRuns(), mine = runs.find((x) => x.buyer_txn === run.buyer_txn && x.at === run.at)!;
  const id = href?.split('/').pop() ?? body.dispute_id;
  if (r.status < 300 && id) mine.dispute_id = id;
  else mine.error = `PayPal ${r.status}: ${body.name ?? ''} ${body.details?.[0]?.issue ?? body.message ?? ''}`.trim();
  write(RUNS, runs);
  if (mine.error) throw new Error(`PayPal didn't open the dispute (${mine.error}). This pool entry is set aside.`);
  return mine;
}

// Timer, as the system: note which waiting cases PayPal has unlocked, retire ones older than 3 days (the agent takes
// them over), and file new ones until each kind has READY_PER_KIND waiting. Filing failures are logged, not retried
// in a loop: the next tick tries the next pool entry.
export async function keepReady(ctx: Ctx, getDispute: (id: string) => Promise<any>, retire: (id: string) => void, log: (msg: string) => void) {
  const runs = readRuns();
  for (const r of runs.filter(waiting)) {
    if (Date.now() - Math.max(Date.parse(r.at), paidAt(r.buyer_txn) + MIN_AGE[r.kind ?? 'unshipped']) > RETIRE_MS) { r.retired_at = new Date().toISOString(); retire(r.dispute_id!); continue; }
    if (!r.unlocked_at) {
      const d = await getDispute(r.dispute_id!).catch(() => null);
      if ((d?.links ?? []).some((l: any) => l.rel !== 'self')) r.unlocked_at = new Date().toISOString();
    }
  }
  write(RUNS, runs);
  for (const kind of KINDS) {
    const need = READY_PER_KIND[kind] - readRuns().filter((r) => r.kind === kind && waiting(r)).length;
    for (let i = 0; i < need && fileable(kind).length; i++) {
      try { const r = await fileOne(ctx, kind); log(`filed ${kind} case ${r.dispute_id} for the ready set`); }
      catch (e: any) { log(`filing a ${kind} case failed: ${e.message}`); break; }
    }
  }
}
