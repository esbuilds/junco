// BLACK BOX, the desk's side (goals 4 to 6): which label an event wears, PayPal's refund id after an approve, and the
// printable receipt. The Incident itself comes from src/incident.ts (Builder A); until that lands, a hand-written fixture.
import qrcode from 'qrcode-generator';
import type { Incident, IncidentEvent, IncidentSummary, Mode, WhatIf } from './incident-types.js';

// ponytail: fixture stand-ins for A's listIncidents/buildIncident/whatIf; swap to './incident.js' when black-box-core lands
export const FIXTURE: Incident = {
  id: 'FIXTURE-BT-0001',
  title: 'Agent bought WKD-01 for "waterproof bag for kayaking"',
  authority: { instruction: 'Buy a waterproof bag for kayaking, under 40 dollars', budget: '40.00 USD', agent: 'Claude shopping agent' },
  purchase: { sku: 'WKD-01', listing: 'Roll-top dry bag, 20 L', reason: 'Matched "waterproof" and "kayaking" in the listing', amount: '34.00 USD', order_id: 'FIXTURE0ORDER0001', capture_id: 'FIXTURE0CAPTURE01' },
  dispute_id: 'PP-D-FIXTURE-1',
  events: [
    { id: 'purchase:FIXTURE-BT-0001', at: '2026-10-21T15:02:10.000Z', kind: 'purchase', actor: 'shopping agent', summary: 'The shopping agent bought WKD-01 for 34.00 USD for "waterproof bag for kayaking".', source: 'pool', ref: { buyer_txn: 'FIXTURE-BT-0001' } },
    { id: 'payment:FIXTURE0CAPTURE01', at: '2026-10-21T15:02:14.000Z', kind: 'payment', actor: 'PayPal', summary: 'PayPal captured 34.00 USD.', source: 'PayPal', ref: { order_id: 'FIXTURE0ORDER0001', capture_id: 'FIXTURE0CAPTURE01' } },
    { id: 'dispute:PP-D-FIXTURE-1', at: '2026-10-23T09:40:00.000Z', kind: 'dispute', actor: 'buyer', summary: 'The buyer disputed it as not as described: the bag leaked.', source: 'store-runs', ref: { dispute_id: 'PP-D-FIXTURE-1', buyer_txn: 'FIXTURE-BT-0001' } },
    { id: 'agent:2026-10-23T09:41:30.000Z', at: '2026-10-23T09:41:30.000Z', kind: 'agent', actor: 'JUNCO agent', summary: 'JUNCO read the case and proposed a full refund of 34.00 USD.', source: 'activity', ref: { dispute_id: 'PP-D-FIXTURE-1' } },
    { id: 'gate:2026-10-23T09:41:31.000Z', at: '2026-10-23T09:41:31.000Z', kind: 'gate', actor: 'gate', summary: 'The gate held the refund: refunds wait for the owner.', source: 'gate-log', ref: { capture_id: 'FIXTURE0CAPTURE01', rule: 'create_refund: hold' } },
    { id: 'hold:fx01', at: '2026-10-23T09:41:31.000Z', kind: 'hold', actor: 'gate', summary: 'Refund of 34.00 USD held for the owner, one-tap link sent.', source: 'holds', ref: { hold_id: 'fx01', capture_id: 'FIXTURE0CAPTURE01' } },
    { id: 'webhook:2026-10-23T11:05:00.000Z', at: '2026-10-23T11:05:00.000Z', kind: 'webhook', actor: 'PayPal', summary: 'PayPal sent CUSTOMER.DISPUTE.UPDATED; the held refund was flagged for a re-check.', source: 'activity', ref: { dispute_id: 'PP-D-FIXTURE-1', hold_id: 'fx01' } },
    { id: 'approval:fx01', at: '2026-10-23T12:20:00.000Z', kind: 'approval', actor: 'owner', summary: 'The owner approved the refund from the one-tap link.', source: 'holds', ref: { hold_id: 'fx01' } },
    { id: 'paypal:FIXTURE0REFUND01', at: '2026-10-23T12:20:02.000Z', kind: 'paypal', actor: 'PayPal', summary: 'PayPal made refund FIXTURE0REFUND01, status COMPLETED.', source: 'PayPal', ref: { refund_id: 'FIXTURE0REFUND01', capture_id: 'FIXTURE0CAPTURE01' } },
  ],
  counts: { proposed: 1, approved: 1, executed: 1, outcome_unknown: 0 },
  missing: ["The buyer's own words to the shopping agent were not recorded, only the instruction the agent saved."],
};
export const listIncidents = async (): Promise<IncidentSummary[]> =>
  [{ id: FIXTURE.id, title: FIXTURE.title, dispute_id: FIXTURE.dispute_id, counts: FIXTURE.counts, last_at: FIXTURE.events.at(-1)!.at }];
export const buildIncident = async (id: string): Promise<Incident | null> => (id === FIXTURE.id ? FIXTURE : null);
export async function whatIf(eventId: string, change: { refund_limit: number }): Promise<WhatIf> {
  const amount = 34, limit = change.refund_limit;
  return {
    mode: 'what-if', event_id: eventId, method: 'create_refund', args: { capture_id: 'FIXTURE0CAPTURE01', amount: { value: '34.00', currency_code: 'USD' } },
    change: `refund limit none -> ${limit} USD`, before: { verdict: 'hold', reason: 'refunds wait for the owner' },
    after: amount <= limit ? { verdict: 'allow', reason: `34.00 is within the ${limit} USD refund limit` } : { verdict: 'hold', reason: `34.00 is over the ${limit} USD refund limit` },
    paypal_calls: 0,
  };
}

// LIVE: something PayPal's sandbox did or said. RECORDED: the desk's own record (agent, gate, hold, owner).
// WHAT-IF events are never in an Incident; they come back from whatIf() and the page draws them apart.
const LIVE = new Set<IncidentEvent['kind']>(['purchase', 'payment', 'dispute', 'paypal', 'webhook']);
export const modeOf = (e: IncidentEvent): Mode => (LIVE.has(e.kind) ? 'live' : 'recorded');

// PayPal's refund id and status from a hold's stored result. The result is the tool's text: PayPal's JSON, sometimes
// wrapped (hosted MCP content, or a settle's `was`), sometimes prose. Null when no refund id is in it.
type Refund = { id: string; status: string | null };
export function paypalRefund(h: { method: string; result?: string }): Refund | null {
  if (!/refund/.test(h.method) || !h.result) return null;
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  const find = (o: any): Refund | null => {
    if (typeof o === 'string') { const p = parse(o); return p === undefined ? null : find(p); }
    if (!o || typeof o !== 'object' || o.error) return null;
    if (typeof o.id === 'string' && !Array.isArray(o)) return { id: o.id, status: typeof o.status === 'string' ? o.status : null };
    for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
    return null;
  };
  const r = find(h.result);
  if (r || parse(h.result) !== undefined) return r;
  const id = h.result.match(/\bid\W{1,4}([0-9A-Z]{10,30})\b/i)?.[1]; // prose: "Refund id: 1AB23..."
  return id ? { id, status: h.result.match(/\bstatus\W{1,4}([A-Z_]{4,})\b/)?.[1] ?? null } : null;
}
// "PayPal made refund 1AB23..., status COMPLETED" after an approve; other actions keep "PayPal accepted it".
export const acceptedText = (h: { method: string; result?: string }) => {
  const r = paypalRefund(h);
  return r ? `PayPal made refund ${r.id}${r.status ? `, status ${r.status}` : ''}` : 'PayPal accepted it';
};

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// One printable page: what was bought, under what authority, how it ended, and a QR back to the incident page.
export function receiptPage(inc: Incident, pageUrl: string) {
  const qr = qrcode(0, 'M'); qr.addData(pageUrl); qr.make();
  const refund = inc.events.find((e) => e.ref?.refund_id)?.ref?.refund_id;
  const row = (k: string, v: unknown) => (v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>JUNCO receipt ${esc(inc.id)}</title><style>
body{margin:0 auto;padding:32px 24px;max-width:640px;background:#fff;color:#1d1d1b;font:14px/1.5 Inter,system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}.m{color:#6b6a64}table{border-collapse:collapse;width:100%;margin:16px 0}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e3e0d8;vertical-align:top}th{width:38%;font-weight:600}
td{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.qr{display:flex;gap:16px;align-items:center;margin-top:16px}
.qr svg{width:140px;height:140px;flex:none}.u{font-family:ui-monospace,monospace;font-size:12px;overflow-wrap:anywhere}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #1f5c4a;background:#1f5c4a;color:#fff}
@media print{button,.np{display:none}body{padding:0}}
</style></head><body>
<p class="m"><strong>JUNCO</strong> · incident receipt</p>
<h1>${esc(inc.title)}</h1>
<table>
${row('Incident id', inc.id)}${row('Capture id', inc.purchase?.capture_id ?? 'not recorded')}${row('Order id', inc.purchase?.order_id)}
${row('Item', inc.purchase && `${inc.purchase.sku}, ${inc.purchase.listing}`)}${row('Amount', inc.purchase?.amount)}
${row('Buyer allowed', inc.authority && `${inc.authority.instruction} (budget ${inc.authority.budget}, ${inc.authority.agent})`)}
${row('Dispute', inc.dispute_id)}${row('PayPal refund id', refund)}
${row('Money moves', `${inc.counts.proposed} proposed, ${inc.counts.approved} approved, ${inc.counts.executed} executed, ${inc.counts.outcome_unknown} outcome unknown`)}
${row('Events on record', `${inc.events.length}, ${inc.events[0]?.at.slice(0, 10) ?? ''} to ${inc.events.at(-1)?.at.slice(0, 10) ?? ''}`)}
${row('Not in the records', inc.missing.join(' '))}
</table>
<div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<div><div>The whole incident, event by event:</div><div class="u">${esc(pageUrl)}</div></div></div>
<p class="m">Built from the desk's records and PayPal's sandbox. Nothing on it was written by a model.</p>
<p class="np"><button onclick="print()">Print</button></p>
</body></html>`;
}
