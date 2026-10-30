// BLACK BOX, the desk's side (goals 4 to 6): which label an event wears, PayPal's refund id after an approve, and the
// printable receipt. The Incident itself comes from src/incident.ts.
import qrcode from 'qrcode-generator';
import type { DrillScore } from './drill-types.js';
import type { Incident, IncidentSummary } from './incident-types.js';
import { paypalRefund } from './reconcile.js';

export { modeOf } from './incident-questions.js';
export { paypalRefund };

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
${row('PayPal fingerprint', inc.purchase && (inc.events.find((e) => e.kind === 'paypal_fingerprint')?.summary ?? 'Not recorded at PayPal (placed before fingerprints).'))}
${row('Outcome', inc.decline && 'The agent bought nothing. No order was placed and no money moved.')}${row("Agent's reason", inc.decline?.reason)}
${row('Listings it saw', inc.decline?.listings.join(' | '))}
${row('Dispute', inc.dispute_id)}${row('PayPal refund id', refund)}
${row('Money moves', !inc.decline && `${inc.counts.proposed} proposed, ${inc.counts.approved} approved, ${inc.counts.executed} executed, ${inc.counts.outcome_unknown} outcome unknown`)}
${row('Events on record', ((a, b) => `${inc.events.length}, ${a === b ? a : `${a} to ${b}`}`)(inc.events[0]?.at.slice(0, 10) ?? '', inc.events.at(-1)?.at.slice(0, 10) ?? ''))}
${row('Not in the records', inc.missing.join(' '))}
</table>
<div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<div><div>The whole incident, event by event:</div><div class="u">${esc(pageUrl)}</div></div></div>
<p class="m">Built from the desk's records and PayPal's sandbox. Nothing on it was written by a model.</p>
<p class="np"><button onclick="print()">Print</button></p>
</body></html>`;
}

// The judges' door (/judges): what anyone can look at without the password, from the desk's own records. The desk passes
// the public incident list (a visitor's own shopping runs are never in it), the decline to feature, and the Escape room's
// counter and latest room runs. Every link on it opens without the password, except "Open the desk".
export type JudgesData = {
  purchases: IncidentSummary[]; decline: IncidentSummary | null;
  escape: { attempts: number; escapes: number; escape_runs: string[] };
  rooms: { id: string; at: string; room: number; title: string; outcome: string }[];
  drill?: DrillScore;
};
const DOCS = 'https://github.com/esbuilds/junco/blob/main/docs/mcp.md';
export function judgesPage(d: JudgesData) {
  const day = (iso: string) => iso.slice(0, 10), plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const links = (id: string) => `<a href="/incident/${encodeURIComponent(id)}">Incident</a> · <a href="/incident/${encodeURIComponent(id)}/receipt">Receipt</a>`;
  const purchases = d.purchases.slice(0, 12).map((i) => `<tr><td>${esc(day(i.last_at))}</td><td>${esc(i.title)}<div class="m">${i.dispute_id ? `Disputed: ${esc(i.dispute_id)}` : 'Not disputed'}</div></td><td class="l">${links(i.id)}</td></tr>`).join('');
  const rooms = d.rooms.map((r) => `<li><a href="/run/${encodeURIComponent(r.id)}">Run ${esc(r.id)}</a> <span class="m">${esc(day(r.at))} · Room ${r.room}: ${esc(r.title)}</span><div>${esc(r.outcome)}</div></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>JUNCO for judges</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet"><style>
/* Graphite, the desk's palette (studio/src/theme.ts), light. */
body{margin:0 auto;padding:40px 24px;max-width:760px;background:#fff;color:#18181b;font:14px/21px Geist,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 20px;font-size:13px;color:#52525b}.brand strong{color:#18181b;font-size:15px;font-weight:600;letter-spacing:-.02em}.brand svg{width:20px;height:20px}
h1{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px}h2{font-size:15px;font-weight:600;margin:28px 0 8px}.m{color:#52525b}
a{color:#18181b}table{border-collapse:collapse;width:100%;border-top:1px solid #e4e4e7}td{padding:9px 12px 9px 0;border-bottom:1px solid #e4e4e7;vertical-align:top}
td:first-child{white-space:nowrap;color:#52525b;font-variant-numeric:tabular-nums}td.l{white-space:nowrap;text-align:right;padding-right:0}
.box{border:1px solid #e4e4e7;border-radius:8px;padding:12px 16px;margin:8px 0}.count{font-size:17px;font-weight:600}ul{padding-left:18px;margin:8px 0}li{margin:6px 0}
.act{background:#fafafa}.btn{display:inline-block;margin-top:8px;padding:7px 14px;border-radius:6px;background:#18181b;color:#fff;text-decoration:none;font-weight:500}
@media (max-width:560px){td.l{white-space:normal}}
</style></head><body>
<p class="brand"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 32V9M32 32L51.92 43.5M32 32V55M32 32L12.08 43.5M32 32L12.08 20.5" fill="none" stroke="#18181b" stroke-width="6.4" stroke-linecap="round"/><circle cx="50.19" cy="21.5" r="4.6" fill="#1f5c4a"/></svg><strong>JUNCO</strong><span>· for judges</span></p>
<h1>JUNCO works a small seller's PayPal disputes, and nothing that moves money goes out without the owner's OK.</h1>
<p class="m">Everything here runs on PayPal's sandbox with test accounts; no real money moves. No password is needed to look. The password lets you act.</p>
<h2>AI purchases on record</h2>
<p class="m">Orders a shopping agent placed for a buyer. Each incident joins what the agent was allowed, what reached PayPal and every money move the gate held, allowed or denied. Nothing in it comes from a model.</p>
${purchases ? `<table>${purchases}</table>` : '<p class="m">None on record yet.</p>'}
${d.decline ? `<h2>When the agent buys nothing</h2><div class="box">${esc(d.decline.title)}<div class="m">No order, no payment. What it was asked, the listings it saw and why it declined are on record.</div><div>${links(d.decline.id)}</div></div>` : ''}
<h2>Escape room</h2>
<p class="m">Visitors try to get the owner's money out past the policy, in five rooms. An escape is money PayPal accepted beyond the owner's limit, read from the gate's and PayPal's records, never from what the AI says.</p>
<div class="box"><span class="count">${plural(d.escape.attempts, 'attempt')}, ${plural(d.escape.escapes, 'escape')}.</span>${d.escape.escapes ? `<div>Money got out in ${d.escape.escape_runs.map((id) => `<a href="/run/${encodeURIComponent(id)}">run ${esc(id)}</a>`).join(', ')}.</div>` : ''}</div>
${rooms ? `<ul>${rooms}</ul>` : ''}
${d.drill ? `<h2>The drill</h2>
<p class="m">A gate stops what goes through it. So a separate program refunds a small amount straight in PayPal, outside the gate, and a fresh Claude with read tools is sent to find it. Sandbox only.</p>
<div class="box"><span class="count">${d.drill.hidden} hidden, ${d.drill.found} found, ${d.drill.missed} missed, ${plural(d.drill.false_alarms, 'false alarm')}.</span><div>Money moved by the investigator: $${d.drill.money_moved_usd.toFixed(2)}.</div><div><a href="/drill">Run the drill</a></div></div>` : ''}
<h2>Sign in to act</h2>
<div class="box act">The password is in the Devpost submission's testing instructions. It lets you:
<ul><li>send your own shopping agent and investigate what it buys</li><li>try the Escape room's rooms yourself</li><li>get your own sandbox dispute and approve or reject what JUNCO holds on it</li><li>connect your own Claude to the desk (<a href="${DOCS}">how</a>)</li></ul>
<a class="btn" href="/">Open the desk</a></div>
</body></html>`;
}
