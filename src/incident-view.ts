// BLACK BOX, the desk's side (goals 4 to 6): which label an event wears, PayPal's refund id after an approve, and the
// printable receipt. The Incident itself comes from src/incident.ts.
import qrcode from 'qrcode-generator';
import type { Incident } from './incident-types.js';

export { modeOf } from './incident-questions.js';

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
<meta name="robots" content="noindex"><title>JUNCO receipt ${esc(inc.id)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet"><style>
/* Graphite, the desk's palette (studio/src/theme.ts); always light, and plain black on white when printed. */
body{margin:0 auto;padding:40px 24px;max-width:640px;background:#fff;color:#18181b;font:14px/20px Geist,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 20px;font-size:13px;color:#52525b}.brand strong{color:#18181b;font-size:15px;font-weight:600;letter-spacing:-.02em}
.brand svg{width:20px;height:20px}h1{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em;margin:0}.m{color:#52525b}
table{border-collapse:collapse;width:100%;margin:20px 0;border-top:1px solid #e4e4e7}
th,td{text-align:left;padding:9px 0;border-bottom:1px solid #e4e4e7;vertical-align:top}th{width:36%;padding-right:16px;font-weight:500;color:#52525b}
td{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.qr{display:flex;gap:20px;align-items:center;margin-top:20px;padding:16px;border:1px solid #e4e4e7;border-radius:8px}
.qr svg{width:140px;height:140px;flex:none}.u{font-family:'Geist Mono',ui-monospace,monospace;font-size:12px;line-height:18px;overflow-wrap:anywhere;margin-top:4px}
button{font:500 13px/18px Geist,system-ui,sans-serif;padding:7px 14px;border-radius:6px;border:1px solid #18181b;background:#18181b;color:#fff;cursor:pointer}
@media print{button,.np{display:none}body{padding:0;color:#000}.m,th,.brand{color:#000}th,td,table,.qr{border-color:#000}.qr{border-radius:0}.brand circle{fill:#000}}
</style></head><body>
<p class="brand"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 32V9M32 32L51.92 43.5M32 32V55M32 32L12.08 43.5M32 32L12.08 20.5" fill="none" stroke="#18181b" stroke-width="6.4" stroke-linecap="round"/><circle cx="50.19" cy="21.5" r="4.6" fill="#1f5c4a"/></svg><strong>JUNCO</strong><span>· incident receipt</span></p>
<h1>${esc(inc.title)}</h1>
<table>
${row('Incident id', inc.id)}${row('Capture id', inc.decline ? null : inc.purchase?.capture_id ?? 'not recorded')}${row('Order id', inc.purchase?.order_id)}
${row('Item', inc.purchase?.listing)}${row('Amount', inc.purchase?.amount)}
${row('Buyer allowed', inc.authority && `${inc.authority.instruction} (budget ${inc.authority.budget}, ${inc.authority.agent})`)}
${row('Outcome', inc.decline && 'The agent bought nothing. No order was placed and no money moved.')}${row("Agent's reason", inc.decline?.reason)}
${row('Listings it saw', inc.decline?.listings.join(' | '))}
${row('Dispute', inc.dispute_id)}${row('PayPal refund id', refund)}
${row('Money moves', !inc.decline && `${inc.counts.proposed} proposed, ${inc.counts.approved} approved, ${inc.counts.executed} executed, ${inc.counts.outcome_unknown} outcome unknown`)}
${row('Events on record', `${inc.events.length}, ${inc.events[0]?.at.slice(0, 10) ?? ''} to ${inc.events.at(-1)?.at.slice(0, 10) ?? ''}`)}
${row('Not in the records', inc.missing.join(' '))}
</table>
<div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<div><div>The whole incident, event by event:</div><div class="u">${esc(pageUrl)}</div></div></div>
<p class="m">Built from the desk's records and PayPal's sandbox. Nothing on it was written by a model.</p>
<p class="np"><button onclick="print()">Print</button></p>
</body></html>`;
}
