// M1 "Dispute this store": a visitor files a real sandbox dispute against the demo store, as the sandbox buyer, and
// watches JUNCO work it. PayPal's buyer-side API needs the BUYER's transaction ID for a paid order, which only the buyer's
// Activity page shows, so paid orders are prepared ahead into a pool (scripts/pool.ts) and each live run uses one.
// PayPal's sandbox turns every API-filed dispute into a chargeback under review within about 30 s (verified Oct 9), so
// offers and buyer messages aren't possible on these cases; JUNCO can send supporting info or hold an accept.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mirror } from './persist.js';
import type { Ctx } from './disputes.js';

export type PoolEntry = { buyer_txn: string; amount: string; order_id?: string; tracking?: boolean; added: string };
export type Run = { at: string; visitor: string; buyer_txn: string; dispute_id?: string; error?: string };
const POOL = '.junco/pool.json', RUNS = '.junco/store-runs.json';
const read = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f: string, v: unknown) => { mkdirSync('.junco', { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2)); mirror(f, v); };
export const readPool = () => read<PoolEntry[]>(POOL, []);
export const readRuns = () => read<Run[]>(RUNS, []);
const used = () => new Set(readRuns().map((r) => r.buyer_txn));
export const liveLeft = () => readPool().filter((p) => !used().has(p.buyer_txn)).length;

// Owner adds prepared orders. Entries already in the pool are skipped.
export function addToPool(entries: any[]): number {
  const pool = readPool(), have = new Set(pool.map((p) => p.buyer_txn));
  const fresh = entries
    .filter((e) => typeof e?.buyer_txn === 'string' && /^[A-Z0-9]{17}$/.test(e.buyer_txn) && !have.has(e.buyer_txn) && Number(e.amount) > 0)
    .map((e) => ({ buyer_txn: e.buyer_txn, amount: Number(e.amount).toFixed(2), order_id: e.order_id, tracking: !!e.tracking, added: new Date().toISOString() }));
  if (fresh.length) write(POOL, [...pool, ...fresh]);
  return fresh.length;
}

// One live run per visitor per day; the pool is the overall cap (STRATEGY v3.9 ruling 10).
const PER_VISITOR = Number(process.env.STORE_DISPUTES_PER_VISITOR ?? 1);
export function refusal(visitor: string): string | null {
  if (!process.env.SANDBOX_BUYER_EMAIL) return 'Live runs are not set up on this desk (no sandbox buyer configured).';
  if (!liveLeft()) return 'No live runs left right now. The recorded run below shows the same thing.';
  const today = new Date().toISOString().slice(0, 10);
  if (readRuns().filter((r) => r.visitor === visitor && r.at.startsWith(today) && r.dispute_id).length >= PER_VISITOR)
    return 'One live run per visitor a day. Your case is below.';
  return null;
}

// The app acts as the sandbox buyer after a one-time consent: PayPal-Auth-Assertion names the buyer, the bearer is ours.
const assertion = (email: string) => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: process.env.PAYPAL_CLIENT_ID ?? process.env.client_id, email })}.`;
};

export async function fileDispute(ctx: Ctx, visitor: string): Promise<Run> {
  const why = refusal(visitor);
  if (why) throw Object.assign(new Error(why), { code: 400 });
  const entry = readPool().find((p) => !used().has(p.buyer_txn))!;
  const run: Run = { at: new Date().toISOString(), visitor, buyer_txn: entry.buyer_txn };
  write(RUNS, [...readRuns(), run]); // claim the pool entry before calling PayPal, so two clicks can't use it twice
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify({
    disputed_transactions: [{ buyer_transaction_id: entry.buyer_txn }],
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    dispute_amount: { currency_code: 'USD', value: entry.amount },
    extensions: { merchant_contacted: false, merchandize_dispute_properties: { issue_type: 'PRODUCT' } },
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
  if (mine.error) throw Object.assign(new Error(`PayPal didn't open the dispute (${mine.error}). This pool entry is set aside.`), { code: 400 });
  return mine;
}
