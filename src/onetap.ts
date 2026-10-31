// M5: approve or reject a hold from a phone, one tap from the Slack message. The link is signed for one hold and
// expires; opening it (GET) only shows the hold, and only the Approve or Reject button (a POST carrying the same
// signature) decides, through the same path as the desk's buttons, so the case is re-read before anything runs.
// The signature stands in for the desk password and the owner cookie, for that one hold only.
import { createHmac, timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';
import { paidOn } from './store-dispute.js';

export const LINK_MS = 48 * 3600_000;
const sig = (key: string, id: string, exp: number) => createHmac('sha256', key).update(`junco-hold:${id}:${exp}`).digest('base64url').slice(0, 32);

export const signedLink = (base: string, key: string, id: string, now = Date.now()) => {
  const exp = now + LINK_MS;
  return `${base}/h/${encodeURIComponent(id)}?e=${exp}&s=${sig(key, id, exp)}`;
};

// Why the link can't be used, or null.
export function linkRefusal(key: string | undefined, id: string, e: string | null, s: string | null, now = Date.now()): string | null {
  if (!key) return 'one-tap links are off on this desk';
  const exp = Number(e);
  if (!exp || !s) return 'this link is incomplete';
  const want = Buffer.from(sig(key, id, exp)), got = Buffer.from(s);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'this link is not valid';
  if (now > exp) return 'this link has expired; open the desk to decide';
  return null;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// "Refund $5.00 on payment 22B5...", "Make dispute offer $40.00 on PP-R-OKQ-...": the action, the money, what it acts on.
const target = (a: any) => a?.dispute_id ?? (a?.capture_id ? `payment ${a.capture_id}` : a?.invoice_id ? `invoice ${a.invoice_id}` : '');
const what = (h: any) => { const m = String(h.method).replace(/^create_/, '').replace(/_/g, ' '); return m.charAt(0).toUpperCase() + m.slice(1); };
const amount = (h: any) => h.args?.offer_amount?.value ?? h.args?.amount?.value ?? h.args?.amount;
// A refund with no amount is the whole payment, and the owner approving it still sees how much: from the hold's payment
// snapshot (taken when it was held) or the store's own order record, never from a new PayPal read.
const dollars = (s: string) => (/^\d+(\.\d+)?( USD)?$/.test(s) ? `$${s.replace(/ USD$/, '')}` : s);
export const fullRefund = (h: any): string | null => {
  if (h?.method !== 'create_refund' || amount(h) != null) return null;
  const paid: string | undefined = h.case?.amount ?? (h.args?.capture_id ? paidOn(h.args.capture_id) : undefined);
  return `Full refund${paid ? ` of ${dollars(paid)}` : ''}`;
};
// The held action in one line: "Full refund of $38.00 on payment 57G...", "Make dispute offer $40.00 on PP-R-...".
export const holdAction = (h: any) => `${fullRefund(h) ?? `${what(h)}${amount(h) ? ` $${amount(h)}` : ''}`}${target(h.args) ? ` on ${target(h.args)}` : ''}`;

// A photo sent with a refund ask, on the page that decides it. Text in it is the buyer's, unverified, and escaped like everything else.
export const photoHtml = (p: { thumb: string; visible: string; looks: string; limits: string }) => `<div style="display:flex;gap:12px;align-items:flex-start;margin:12px 0"><img src="${esc(p.thumb)}" alt="The photo the buyer sent, small copy" style="width:88px;height:88px;object-fit:cover;border-radius:6px"><p class="m" style="margin:0">A photo the buyer sent, unverified. ${esc(p.visible)} ${esc(p.looks)} ${esc(p.limits)}</p></div>`;

// The page: what is held and why, and two buttons. `note` is the outcome after a POST, or why the link can't be used.
export function holdPage(h: any | null, q: { e: string | null; s: string | null }, desk: string, note?: { ok: boolean; text: string }) {
  const body = !h ? `<p class="err">${esc(note?.text ?? 'No such hold.')}</p>` : `
    <h1>${esc(holdAction(h))}</h1>
    <p class="m">Held for you. ${esc(h.reason)}.${h.asked_by ? ` Asked by the ${esc(h.asked_by)}.` : ''}</p>
    ${h.case && 'stage' in h.case ? `<p class="m">When it was held the case was at ${esc(h.case.stage)}, ${esc(h.case.amount)}.</p>` : h.case ? `<p class="m">When it was held the payment was ${esc(h.case.status)}.</p>` : ''}
    ${h.status === 'pending' && h.recheck ? `<p class="err">Re-check: PayPal says this changed since it was held (${esc(h.recheck.event)}). ${h.recheck.refund ? `PayPal reported refund ${esc(h.recheck.refund.id)} on this payment, so approving will refuse it.` : 'Approving re-reads it first.'}</p>` : ''}
    ${h.photo ? photoHtml(h.photo) : ''}
    ${note ? `<p class="${note.ok ? 'ok' : 'err'}">${esc(note.text)}</p>` : ''}
    ${h.status === 'pending' && !(note && !note.ok && /link/.test(note.text)) ? `
    <form method="post">
      <input type="hidden" name="e" value="${esc(q.e)}"><input type="hidden" name="s" value="${esc(q.s)}">
      <button name="verb" value="approve" class="a">Approve</button>
      <button name="verb" value="reject" class="r">Reject</button>
    </form>
    <p class="m">Approving re-reads the case on PayPal first. If it has moved on since this was held, nothing is sent.</p>`
    : !note ? `<p>${h.status === 'expired' ? "This hold expired: the owner didn't decide within 24 hours, so nothing moved." : `This hold is already ${esc(h.status)}.`}</p>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>JUNCO: a hold for you</title><style>
:root{color-scheme:light dark;--bg:#f7f5f0;--ink:#1d2421;--m:#5d6662;--acc:#1f5c4a;--danger:#a8322a}
@media (prefers-color-scheme:dark){:root{--bg:#141816;--ink:#e8ece9;--m:#9aa49f;--acc:#5fb497;--danger:#ef8a80}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.45 Inter,system-ui,sans-serif;max-width:560px}
h1{font-size:21px;margin:0 0 8px}.m{color:var(--m)}.ok{color:var(--acc);font-weight:600}.err{color:var(--danger);font-weight:600}
form{display:flex;gap:12px;margin:20px 0 8px}button{flex:1;font:inherit;font-weight:600;padding:14px;border-radius:10px;border:1px solid var(--m);background:transparent;color:var(--ink)}
button.a{background:var(--acc);border-color:var(--acc);color:#fff}button.r{color:var(--danger);border-color:var(--danger)}a{color:var(--acc)}
</style></head><body><p class="m"><strong>JUNCO</strong> · a hold for you</p>${body}<p class="m"><a href="${esc(desk)}">Open the desk</a></p></body></html>`;
}

// Offline check: npx tsx src/onetap.ts
if (process.argv[1]?.endsWith('onetap.ts')) {
  const link = new URL(signedLink('https://d', 'k', 'abc123', 1000));
  const [e, s] = [link.searchParams.get('e'), link.searchParams.get('s')];
  assert.equal(linkRefusal('k', 'abc123', e, s, 2000), null);
  assert.match(linkRefusal('k', 'other', e, s, 2000)!, /not valid/); // signed for one hold only
  assert.match(linkRefusal('wrong', 'abc123', e, s, 2000)!, /not valid/);
  assert.match(linkRefusal('k', 'abc123', String(Number(e) + 1), s, 2000)!, /not valid/); // can't stretch the expiry
  assert.match(linkRefusal('k', 'abc123', e, s, 1000 + LINK_MS + 1)!, /expired/);
  assert.match(linkRefusal(undefined, 'abc123', e, s)!, /off/);
  const page = holdPage({ method: 'make_dispute_offer', args: { dispute_id: '<x>', offer_amount: { value: '40.00' } }, reason: 'r', status: 'pending' }, { e, s }, 'https://d');
  assert.ok(page.includes('&#60;x&#62;') && page.includes('method="post"'));
  assert.ok(!holdPage({ method: 'm', args: {}, reason: 'r', status: 'rejected' }, { e, s }, 'https://d').includes('<form'));
  assert.ok(holdPage(null, { e, s }, 'https://d', { ok: false, text: 'this link is not valid' }).includes('this link is not valid'));
  // A refund with no amount is the whole payment: the title says so, with the captured amount from the hold's snapshot.
  const full = { method: 'create_refund', args: { capture_id: 'CAPTUREWITHSNAP1' }, reason: 'policy: create_refund = hold', status: 'pending', case: { capture_id: 'CAPTUREWITHSNAP1', status: 'COMPLETED', update_time: 't', amount: '38.00 USD' } };
  assert.ok(holdPage(full, { e, s }, 'https://d').includes('<h1>Full refund of $38.00 on payment CAPTUREWITHSNAP1</h1>'));
  assert.equal(holdAction({ ...full, case: { ...full.case, amount: '40.00 EUR' } }), 'Full refund of 40.00 EUR on payment CAPTUREWITHSNAP1');
  assert.equal(holdAction({ method: 'create_refund', args: { capture_id: 'NOTINANYRECORD01' } }), 'Full refund on payment NOTINANYRECORD01'); // amount not on record: still "Full refund"
  assert.equal(holdAction({ method: 'create_refund', args: { capture_id: 'C1', amount: { value: '5.00', currency_code: 'USD' } } }), 'Refund $5.00 on payment C1');
  assert.equal(holdAction({ method: 'make_dispute_offer', args: { dispute_id: 'PP-1', offer_amount: { value: '40.00' } } }), 'Make dispute offer $40.00 on PP-1');
  assert.equal(fullRefund({ method: 'make_dispute_offer', args: {} }), null);
  console.log('one-tap: signed per hold, expiry can\'t be stretched, expired refused, page escapes and offers buttons only while pending; a full refund says so, with how much');
}
