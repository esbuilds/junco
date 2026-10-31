// "Approve it yourself" (Oct 30): only the owner can approve, so a judge who sent their own agent and asked for a refund
// stopped at a hold. This lets that visitor decide that one hold, from a phone, and nothing else.
// The link is its own capability, not the owner's one-tap (onetap.ts): another HMAC context, bound to the hold, its purchase
// and the visitor's session. The session is signed but never in the URL, because a QR code must not carry a cookie's value;
// the server reads it from the ask. The link proves its holder has it, never who they are. GET only shows; POST decides
// through the desk's decideHold, the owner's path, so every re-check still runs, and it records as the demo approver.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import qrcode from 'qrcode-generator';
import { readHolds, type Hold } from './gate.js';
import { acceptedText } from './incident-view.js';
import { holdAction } from './onetap.js';
import { ASKER } from './refund-ask.js';
import { DEMO_APPROVER, PUBLIC_SESSION, readAgentBuys, readDemoDecisions, readRefundAsks, saveDemoDecision } from './store-dispute.js';

export const DEMO_PATH = '/demo-approve';
export const YOU_ARE = "You are the demo approver for this one sandbox refund. You can't approve anything else.";
const PER_VISITOR = 1, PER_DAY = () => Number(process.env.DEMO_APPROVE_PER_DAY ?? 5);
const sig = (key: string, hold: string, capture: string, session: string, exp: number) =>
  createHmac('sha256', key).update(`junco-demo-approver:${JSON.stringify([hold, capture, session, exp])}`).digest('base64url').slice(0, 32);
const holdTag = (id: string) => { try { return JSON.parse(readFileSync('.junco/hold-tags.json', 'utf8'))[id] as string | undefined; } catch { return undefined; } };

// The only holds this reaches: a create_refund made by "Ask for your money back" on the asking visitor's own purchase, with
// the ask's 24 hours. The ask names the hold, but the gate can join an identical call to someone else's hold, so the tag,
// the expiry and the capture are checked too. Never a hold made any other way, a dispute hold or a Who else? hold.
export function demoTarget(id: string) {
  const hold = readHolds().find((h) => h.id === id), ask = readRefundAsks().find((a) => a.hold_id === id && a.outcome === 'held');
  const buy = ask && readAgentBuys().find((b) => b.capture_id === ask.capture_id);
  if (!hold || !ask || !buy || !hold.expires) return null;
  const a = hold.args ?? {}, amount = a.amount?.value ?? a.amount;
  const own = hold.method === 'create_refund' && !a.dispute_id && !hold.origin && a.capture_id === buy.capture_id && holdTag(id) === ASKER
    && ask.session === buy.session && ask.session !== PUBLIC_SESSION && (amount == null || (Number(amount) > 0 && Number(amount) <= Number(buy.amount)));
  return own ? { hold, ask, buy } : null;
}

const used = (id: string) => readDemoDecisions().some((d) => d.hold_id === id);
function capRefusal(session: string, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10), approvals = readDemoDecisions().filter((d) => d.verb === 'approve' && d.at.startsWith(today));
  if (approvals.filter((d) => d.session === session).length >= PER_VISITOR) return `You've had your demo approval for today (${PER_VISITOR} a visitor). Nothing was sent to PayPal.`;
  if (approvals.length >= PER_DAY()) return "The desk has had its demo approvals for today. This one still waits for the owner. Nothing was sent to PayPal.";
  return null;
}

// Why the link can't be used, or null. It runs out with the hold, so it can't outlive what it decides.
export function demoRefusal(key: string | undefined, id: string, e: string | null, s: string | null, now = Date.now()): string | null {
  if (!key) return 'demo approval is off on this desk';
  const exp = Number(e);
  if (!exp || !s) return 'this link is incomplete';
  const t = demoTarget(id);
  if (!t) return 'this link is not valid';
  const want = Buffer.from(sig(key, id, t.ask.capture_id, t.ask.session, exp)), got = Buffer.from(s);
  if (want.length !== got.length || !timingSafeEqual(want, got) || exp !== Date.parse(t.hold.expires!)) return 'this link is not valid';
  if (now > exp) return 'this link has expired, so nothing moved';
  return null;
}

// What the incident offers: the visitor who asked, and only them, while the hold is theirs to decide. The desk adds this to
// the page's JSON itself, so the link never reaches the connector's copy of an incident, or a model.
export function demoOffer(key: string | undefined, base: string, id: string | null | undefined, viewer: { owner: boolean; session: string }) {
  if (!key || !id || viewer.owner || viewer.session === PUBLIC_SESSION) return undefined;
  const t = demoTarget(id);
  if (!t || t.ask.session !== viewer.session || t.hold.status !== 'pending' || used(id)) return undefined;
  const why = capRefusal(viewer.session);
  if (why) return { url: null, qr: null, why, expires: t.hold.expires! };
  const exp = Date.parse(t.hold.expires!), url = `${base}${DEMO_PATH}/${encodeURIComponent(id)}?e=${exp}&s=${sig(key, id, t.ask.capture_id, t.ask.session, exp)}`;
  const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  return { url, qr: qr.createDataURL(5, 8), why: null, expires: t.hold.expires! };
}

export type DemoDeps = { key: () => string | undefined; desk: string; decide: (id: string, verb: 'approve' | 'reject', session: string) => Promise<Hold> };
type Q = { e: string | null; s: string | null };
const page = (status: number, deps: DemoDeps, id: string, q: Q, note?: { ok: boolean; text: string }, why?: string) => ({ status, html: demoPage(why ? null : demoTarget(id)?.hold ?? null, q, deps.desk, id, note) });

export function demoShow(deps: DemoDeps, id: string, q: Q, now = Date.now()) {
  const why = demoRefusal(deps.key(), id, q.e, q.s, now);
  return why ? page(403, deps, id, q, { ok: false, text: why }, why) : page(200, deps, id, q);
}

export async function demoDecide(deps: DemoDeps, id: string, q: Q, verb: 'approve' | 'reject', now = Date.now()) {
  const why = demoRefusal(deps.key(), id, q.e, q.s, now);
  if (why) return page(403, deps, id, q, { ok: false, text: why }, why);
  const t = demoTarget(id)!;
  if (used(id)) return page(409, deps, id, q, { ok: false, text: 'This link has been used.' });
  if (t.hold.status !== 'pending') return page(409, deps, id, q);
  const cap = verb === 'approve' ? capRefusal(t.ask.session, now) : null;
  if (cap) return page(429, deps, id, q, { ok: false, text: cap });
  // Spent before anything reaches PayPal, with no await before it, so a double tap can't run twice and the caps count first.
  // ponytail: if the owner decides in the same instant, the gate refuses one and this record may still name the visitor.
  saveDemoDecision({ hold_id: id, capture_id: t.ask.capture_id, session: t.ask.session, at: new Date(now).toISOString(), verb });
  try {
    const h = await deps.decide(id, verb, t.ask.session);
    const ok = h.status === 'completed' || h.status === 'rejected';
    return page(ok ? 200 : 502, deps, id, q, { ok, text: verb === 'reject' ? 'Rejected. Nothing was sent to PayPal.' : h.status === 'completed' ? `Approved. ${acceptedText(h)}.` : `Approved, but ${h.status === 'failed' ? 'PayPal refused it' : `the outcome is ${h.status}; the desk will re-read PayPal`}.` });
  } catch (e: any) { return page(409, deps, id, q, { ok: false, text: e.message }); }
}

// The outcome on a Gate record row, and which count it belongs in. gate.ts words every decision as the owner's.
export const demoRows = <R extends { hold_id?: string; outcome: string }>(rows: R[]): R[] => {
  const mine = new Set(readDemoDecisions().map((d) => d.hold_id));
  return rows.map((r) => (r.hold_id && mine.has(r.hold_id) ? { ...r, outcome: r.outcome.replace('by the owner', `by ${DEMO_APPROVER}`) } : r));
};

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ENDED: Record<string, string> = { expired: 'This hold expired: nobody decided within 24 hours, so nothing moved.', rejected: 'This hold was rejected, so nothing was sent to PayPal.', stale: 'This hold was not run, so nothing was sent to PayPal.' };
export function demoPage(h: Hold | null, q: Q, desk: string, id: string, note?: { ok: boolean; text: string }) {
  const open = h?.status === 'pending' && !used(id) && !note;
  const body = !h ? `<p class="err">${esc(note?.text ?? 'No such hold.')}</p>` : `
    <h1>${esc(holdAction(h))}</h1>
    <p>${esc(YOU_ARE)}</p>
    <p class="m">This is PayPal's sandbox, so no real money moves. This link proves you hold it, not who you are, and you aren't the store's owner: the record will say ${esc(DEMO_APPROVER)}.</p>
    ${note ? `<p class="${note.ok ? 'ok' : 'err'}">${esc(note.text)}</p>` : ''}
    ${h.status === 'pending' && h.recheck ? `<p class="err">PayPal says this changed since it was held (${esc(h.recheck.event)}). Approving re-reads it first.</p>` : ''}
    ${open ? `<form method="post">
      <input type="hidden" name="e" value="${esc(q.e)}"><input type="hidden" name="s" value="${esc(q.s)}">
      <button name="verb" value="approve" class="a">Approve</button>
      <button name="verb" value="reject" class="r">Reject</button>
    </form>
    <p class="m">It works once. Approving re-reads the payment on PayPal first, and if it has changed since this was held, nothing is sent.</p>`
    : !note ? `<p>${esc(used(id) ? 'This link has been used.' : ENDED[h.status] ?? `This hold is already ${h.status}.`)}</p>` : ''}
    ${h.args?.capture_id && !open ? `<p class="m"><a href="${esc(desk)}/incident/${encodeURIComponent(h.args.capture_id)}">See it on the incident</a></p>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>JUNCO: approve it yourself</title><style>
/* Graphite, the desk's palette (studio/src/theme.ts), light. */
body{margin:0 auto;padding:24px 16px;max-width:560px;background:#fff;color:#18181b;font:16px/24px Geist,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
h1{font-size:20px;line-height:28px;font-weight:600;margin:0 0 8px;overflow-wrap:anywhere}p{overflow-wrap:anywhere}.m{color:#52525b}.ok{color:#1f5c4a;font-weight:600}.err{color:#b42318;font-weight:600}
form{display:flex;gap:12px;margin:20px 0 8px}button{flex:1;font:inherit;font-weight:600;padding:14px;border-radius:8px;border:1px solid #18181b;background:#fff;color:#18181b;cursor:pointer}
button.a{background:#18181b;color:#fff}button.r{color:#b42318;border-color:#b42318}button:focus-visible,a:focus-visible{outline:2px solid #1f5c4a;outline-offset:2px}a{color:#18181b}
</style></head><body><p class="m"><strong>JUNCO</strong> · approve it yourself</p>${body}</body></html>`;
}
