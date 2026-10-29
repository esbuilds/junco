// M5: approve or reject a hold from a phone, one tap from the Slack message. The link is signed for one hold and
// expires; opening it (GET) only shows the hold, and only the Approve or Reject button (a POST carrying the same
// signature) decides, through the same path as the desk's buttons, so the case is re-read before anything runs.
// The signature stands in for the desk password and the owner cookie, for that one hold only.
import { createHmac, timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';

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

// The page: what is held and why, and two buttons. `note` is the outcome after a POST, or why the link can't be used.
export function holdPage(h: any | null, q: { e: string | null; s: string | null }, desk: string, note?: { ok: boolean; text: string }) {
  const body = !h ? `<p class="err">${esc(note?.text ?? 'No such hold.')}</p>` : `
    <h1>${esc(what(h))}${amount(h) ? ` $${esc(amount(h))}` : ''}${target(h.args) ? ` on ${esc(target(h.args))}` : ''}</h1>
    <p class="m">Held for you. ${esc(h.reason)}.${h.asked_by ? ` Asked by the ${esc(h.asked_by)}.` : ''}</p>
    ${h.case && 'stage' in h.case ? `<p class="m">When it was held the case was at ${esc(h.case.stage)}, ${esc(h.case.amount)}.</p>` : h.case ? `<p class="m">When it was held the payment was ${esc(h.case.status)}.</p>` : ''}
    ${h.status === 'pending' && h.recheck ? `<p class="err">Re-check: PayPal says this changed since it was held (${esc(h.recheck.event)}). ${h.recheck.refund ? `PayPal reported refund ${esc(h.recheck.refund.id)} on this payment, so approving will refuse it.` : 'Approving re-reads it first.'}</p>` : ''}
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
  console.log('one-tap: signed per hold, expiry can\'t be stretched, expired refused, page escapes and offers buttons only while pending');
}
