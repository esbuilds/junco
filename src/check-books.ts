// THE BOOKS, offline: every AI purchase on one row against a stand-in PayPal GET. Differences come first, a failed read shows
// as unread and never as agreement, reads are bounded and go through reconcile's cache, a visitor's private purchase stays
// private, the policy replay reaches no PayPal and changes nothing, and the route stays behind the desk password.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { books } from './books.js';
import { fingerprint } from './fingerprint.js';
import { byDifference } from './incident-questions.js';
import type { BooksRow } from './incident-types.js';
import { isPublic } from './public.js';
import type { PayPalGet } from './reconcile.js';
import { actor } from './store-dispute.js';

const imports = (f: string) => [...readFileSync(`src/${f}`, 'utf8').matchAll(/^import (?!type )[^;]*?from '([^']+)'/gm)].map((m) => m[1]);
assert.ok(!imports('books.ts').some((i) => /disputes|server|agent|hosted|recommend/.test(i)), 'books.ts imports a PayPal client');
assert.equal(isPublic('GET', '/api/books'), false, 'the Books need the desk password');
const DESK = readFileSync('src/desk.ts', 'utf8'), APP = readFileSync('studio/src/App.tsx', 'utf8'), WIDGET = readFileSync('studio/src/widgets/BooksWidget.tsx', 'utf8');
assert.match(DESK, /url\.pathname === '\/api\/books'\) return json\(res, 200, await books\(/);
assert.match(APP, /usePoll<BooksRow\[\]>\(page === 'books' \? '\/api\/books' : null/, 'only the Books page reads PayPal for every purchase');
assert.ok(WIDGET.includes('jd-mode-what-if') && WIDGET.includes('jd-mode-live') && WIDGET.includes('jd-mode-recorded'), 'LIVE, RECORDED and WHAT-IF wear their own labels');
assert.ok(WIDGET.includes('byDifference'), 'differences pinned first, also after a filter');

globalThis.fetch = (async () => { throw new Error('check-books: no network'); }) as any;
delete process.env.DATABASE_URL; // no Postgres mirror from a fixture run
const dir = mkdtempSync(join(tmpdir(), 'junco-books-'));
copyFileSync('policy.json', join(dir, 'policy.json'));
process.chdir(dir);
mkdirSync('.junco');
const put = (f: string, v: unknown) => writeFileSync(`.junco/${f}`, JSON.stringify(v));

const API = 'https://api.sandbox.paypal.com', amt = (v: string) => ({ value: v, currency_code: 'USD' });
const agent = (cap: string, extra = {}) => ({ instruction: `bag ${cap}`, budget: '45', sku: 'WKD-03', listing: 'WKD-03 listing', reason: 'fits', agent: 'Check shopper', capture_id: cap, paid_at: '2026-10-30T09:56:00.000Z', ...extra });
const buy = (cap: string, added: string, extra = {}) => ({ buyer_txn: `T${cap}`.padEnd(17, 'X'), amount: '38.00', order_id: `O${cap}`, tracking: false, added, agent: agent(cap, extra) });
const txn = (cap: string) => buy(cap, '').buyer_txn;
const m = { model: 'check', at: '2026-10-30T09:56:00.000Z' };
const signed = (cap: string) => { const a = agent(cap); return { mandate: { ...m, fingerprint: fingerprint({ instruction: a.instruction, budget: a.budget, ...m }), paypal: { custom_id: `junco:m:${fingerprint({ instruction: a.instruction, budget: a.budget, ...m })}`, read_at: m.at } } }; };
const forged = (cap: string) => { const s = signed(cap); return { mandate: { ...s.mandate, paypal: { custom_id: 'junco:m:000000000000', read_at: m.at } } }; };
const none = (cap: string) => { const s = signed(cap); return { mandate: { ...s.mandate, paypal: { read_at: m.at } } }; };
const unreadAtCapture = (cap: string) => { const s = signed(cap); return { mandate: { model: s.mandate.model, at: s.mandate.at, fingerprint: s.mandate.fingerprint } }; };
const EXTRA = Array.from({ length: 8 }, (_, i) => `CAPMORE${i}`);
put('pool.json', [buy('CAPAGREE', '2026-10-30T10:00:00.000Z'), buy('CAPOLD', '2026-10-01T10:00:00.000Z'), buy('CAPOUT', '2026-10-30T09:00:00.000Z', signed('CAPOUT')),
  buy('CAPHELD', '2026-10-30T10:00:00.000Z'), buy('CAPDOWN', '2026-10-30T10:00:00.000Z'), buy('CAPFORGE', '2026-10-30T10:00:00.000Z', forged('CAPFORGE')),
  buy('CAPNONE', '2026-10-30T10:00:00.000Z', none('CAPNONE')), buy('CAPNOREAD', '2026-10-30T10:00:00.000Z', unreadAtCapture('CAPNOREAD')), buy('CAPREPLAY', '2026-10-30T10:00:00.000Z'),
  { ...buy('CAPMISSING', '2026-10-30T10:00:00.000Z'), agent: agent('') }, ...EXTRA.map((c) => buy(c, '2026-10-29T10:00:00.000Z'))]);
put('store-runs.json', [{ at: '2026-10-30T10:00:00.000Z', visitor: 'v1', buyer_txn: txn('CAPHELD'), kind: 'agent', dispute_id: 'PP-D-HELD' }]);
put('declines.json', [{ id: 'decline-20261030100000000', at: '2026-10-30T10:00:00.000Z', instruction: 'a tent', budget: '45', agent: 'Check shopper', reason: 'no tents', listings: [] }]);
put('agent-buys.json', [{ capture_id: 'CAPPRIVATE', order_id: 'OCAPPRIVATE', amount: '38.00', agent: agent('CAPPRIVATE', { instruction: 'a private ask' }), session: 'mine', added: '2026-10-30T10:00:00.000Z' }]);
put('holds.json', [{ id: 'hreplay', method: 'create_refund', args: { capture_id: 'CAPREPLAY', amount: amt('5.00') }, reason: 'policy: create_refund = hold', created: '2026-10-30T10:00:00.000Z', status: 'rejected' }]);
const allowed = (at: string, cap: string) => ({ at, method: 'create_refund', args: { capture_id: cap, amount: amt('2.00') }, verdict: 'allow', reason: 'within the limit then', source: 'desk agent' });
put('gate-log.json', [allowed('2026-10-30T10:02:00.000Z', 'CAPREPLAY')]); // today's policy holds every refund, so this one changes
const before = readFileSync('.junco/holds.json', 'utf8') + readFileSync('.junco/gate-log.json', 'utf8');

const entry = (id: string, cap: string, v: string, status: string, refunded: string) => ({ id, amount: amt(v), status, seller_payable_breakdown: { total_refunded_amount: amt(refunded) }, links: [{ rel: 'up', href: `${API}/v2/payments/captures/${cap}` }] });
const PAYPAL: Record<string, { status: string; reason?: string; refunds: any[] }> = {
  CAPOUT: { status: 'PARTIALLY_REFUNDED', refunds: [entry('RFOUT', 'CAPOUT', '1.37', 'COMPLETED', '1.37')] },
  CAPHELD: { status: 'PENDING', reason: 'BUYER_COMPLAINT', refunds: [entry('RFHELD', 'CAPHELD', '59.35', 'PENDING', '0.00')] },
};
let reads = 0, now = 0, most = 0;
const get: PayPalGet = async (p) => {
  reads++; now++; most = Math.max(most, now);
  await new Promise((ok) => setTimeout(ok, 2));
  now--;
  const cap = p.split('/').pop()!.replace(/^O(?=CAP)/, '');
  if (cap === 'CAPDOWN') throw new Error('socket hang up');
  const o = PAYPAL[cap] ?? { status: 'COMPLETED', refunds: [] };
  return p.includes('captures') ? { status: 200, body: { status: o.status, ...(o.reason && { status_details: { reason: o.reason } }), links: [{ rel: 'up', href: `${API}/v2/checkout/orders/O${cap}` }] } }
    : { status: 200, body: { purchase_units: [{ payments: { refunds: o.refunds } }] } };
};
const asOwner = <T>(f: () => Promise<T>) => actor.run({ owner: true, session: 'owner' } as any, f);
const rows = await asOwner(() => books(get));
const row = (cap: string) => rows.find((r) => r.purchase === txn(cap))!;

assert.equal(most <= 4 && most > 1, true, `at most 4 PayPal reads at once, saw ${most}`);
assert.ok(!rows.some((r) => r.purchase.startsWith('decline-')), 'a decline is no purchase');
assert.equal(rows.length, 19);
console.log('rows: every purchase, no declines; at most 4 PayPal reads at once');

assert.deepEqual(row('CAPOUT'), { purchase: txn('CAPOUT'), title: `Agent bought WKD-03 for "bag CAPOUT"`, at: row('CAPOUT').at, paid: 38, paypal_status: 'PARTIALLY_REFUNDED', refunds: '1.37 USD', holds: 0,
  fingerprint: 'Match', reconciliation: 'Differ', line: 'The records differ. PayPal shows a refund of 1.37 USD (RFOUT, COMPLETED) that the desk has no record of.', replay: 'No moves', replay_detail: 'No money moves to re-run.' });
assert.equal(row('CAPHELD').reconciliation, 'Agree', 'a dispute hold is not a difference');
assert.equal(row('CAPHELD').paypal_status, 'PENDING: BUYER_COMPLAINT');
assert.equal(row('CAPHELD').refunds, 'None (dispute hold 59.35 USD)');
assert.equal(row('CAPAGREE').refunds, 'None');
assert.deepEqual([row('CAPAGREE').fingerprint, row('CAPFORGE').fingerprint, row('CAPNONE').fingerprint, row('CAPNOREAD').fingerprint], ['Before fingerprints', 'Mismatch', 'Not recorded', 'Not read']);
assert.equal(row('CAPFORGE').reconciliation, 'Differ');
assert.deepEqual([row('CAPDOWN').paypal_status, row('CAPDOWN').refunds, row('CAPDOWN').reconciliation], ['Unread', 'Unread', 'Unread']);
const missing = rows.find((r) => r.purchase === buy('CAPMISSING', '').buyer_txn)!;
assert.deepEqual([missing.paypal_status, missing.reconciliation], ['Unread', 'Unread']);
console.log("columns: PayPal's status, refunds, fingerprint and reconciliation, a dispute hold no difference, a failed read unread");

assert.deepEqual(rows.map((r) => r.reconciliation).slice(0, 2), ['Differ', 'Differ']);
const ranks = rows.map((r) => ['Differ', 'Unread', 'Agree'].indexOf(r.reconciliation));
assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'differences, then unread, then agreement');
const shuffled: BooksRow[] = [...rows].reverse().sort(byDifference);
assert.deepEqual(shuffled.map((r) => r.purchase), rows.map((r) => r.purchase), 'the order holds wherever the rows come from');
console.log('order: differences pinned first, then what went unread');

assert.deepEqual([row('CAPREPLAY').holds, row('CAPREPLAY').replay], [1, 'Changed today']);
assert.equal(row('CAPREPLAY').replay_detail, 'create refund: hold then, hold today. create refund: allow then, hold today.'); // oldest first
assert.equal(row('CAPAGREE').replay, 'No moves');
const same = await asOwner(() => { put('gate-log.json', []); return books(get); });
assert.equal(same.find((r) => r.purchase === txn('CAPREPLAY'))!.replay, 'Same today');
put('gate-log.json', [allowed('2026-10-30T10:02:00.000Z', 'CAPREPLAY')]);
assert.equal(readFileSync('.junco/holds.json', 'utf8') + readFileSync('.junco/gate-log.json', 'utf8'), before, 'the replay changed a record');
console.log('replay: each recorded move under today\'s policy, changed moves named, nothing written');

const cached = reads;
await asOwner(() => books(get));
assert.equal(reads, cached, 'a second look inside a minute reached PayPal, and it re-ran the replay on every row');
console.log('cache: a second look inside a minute makes no PayPal call, and the replay never does');

const owners = await asOwner(() => books(get));
assert.ok(owners.some((r) => r.title.includes('a private ask')), 'the owner sees every purchase');
const other = await actor.run({ owner: false, session: 'someone else' } as any, () => books(get));
assert.ok(!other.some((r) => r.title.includes('a private ask')), "another visitor's purchase leaked");
const theirs = await actor.run({ owner: false, session: 'mine' } as any, () => books(get));
assert.ok(theirs.some((r) => r.title.includes('a private ask')));
console.log("private: a visitor's own purchase lists for them and the owner, no one else");
console.log('books: ok');
