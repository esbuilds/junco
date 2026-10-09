// Case file: one dispute as a packet a person can read, forward or attach: facts, numbered evidence, JUNCO's argument
// with its citations, the approval history and the timeline. Markdown for copying; HTML for the browser's own
// print-to-PDF (no PDF library).
import type { Evidence } from './recommend.js';
import type { Saved, Activity } from './agent.js';
import type { Hold } from './gate.js';

type Input = { d: any; evidence: Evidence[]; saved: Saved | null; holds: Hold[]; activity: Activity[] };
const human = (s: string) => String(s ?? '').toLowerCase().replace(/_/g, ' ');

export function caseMarkdown({ d, evidence, saved, holds, activity }: Input): string {
  const rec = saved?.recommendation;
  const lines = [
    `# Dispute ${d.dispute_id}`,
    '',
    `- Reason: ${human(d.reason)}`,
    `- Amount: ${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}`,
    `- Stage and status: ${d.dispute_life_cycle_stage === 'CHARGEBACK' && d.dispute_channel === 'INTERNAL' ? 'PayPal claim' : human(d.dispute_life_cycle_stage)}, ${human(d.status)}`,
    `- Opened: ${d.create_time ?? 'unknown'}${d.seller_response_due_date ? `; seller response due ${d.seller_response_due_date}` : ''}`,
    `- PayPal sandbox case. Prepared ${new Date().toISOString().slice(0, 10)} by JUNCO.`,
    '',
    '## Evidence',
    '',
    ...evidence.map((e) => `${e.id}. ${e.text} _(${e.source})_`),
    '',
    '## Recommendation',
    '',
  ];
  if (!rec) lines.push('Not reviewed yet.');
  else {
    lines.push(`**${human(rec.decision)}**${rec.offer_amount ? ` ${rec.offer_amount} ${d.dispute_amount?.currency_code}` : ''}: ${rec.summary}`, '');
    for (const c of rec.claims) lines.push(`- ${c.text} [${c.evidence_ids.join(', ')}]`);
    if (rec.would_change_mind) lines.push('', `What would change this: ${rec.would_change_mind}`);
    if (saved?.problems.length) lines.push('', `Blocked by checks: ${saved.problems.join('; ')}`);
    lines.push('', `Checked ${saved!.at}. Every claim cites the evidence above; JUNCO's validator rejects claims that cite nothing or cite evidence that isn't there.`);
  }
  if (holds.length) { lines.push('', '## Approvals', ''); for (const h of holds) lines.push(`- ${h.created}: ${human(h.method)} held (${h.reason}), ${h.status === 'pending' ? 'waiting for the owner' : `${h.status} by the owner`}`); }
  if (activity.length) { lines.push('', '## Timeline', ''); for (const a of [...activity].sort((x, y) => x.at.localeCompare(y.at))) lines.push(`- ${a.at}: ${a.step}. ${a.detail}`); }
  return lines.join('\n') + '\n';
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
// ponytail: minimal markdown to HTML for this packet's own shapes (headings, bullets, numbered lines, bold, italics)
export function caseHtml(input: Input): string {
  const md = caseMarkdown(input);
  const body = md.split('\n').map((l) => {
    const t = esc(l).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/_\((.+?)\)_/g, '<em>($1)</em>');
    if (l.startsWith('# ')) return `<h1>${t.slice(2)}</h1>`;
    if (l.startsWith('## ')) return `<h2>${t.slice(3)}</h2>`;
    if (l.startsWith('- ')) return `<p class="b">${t.slice(2)}</p>`;
    return l ? `<p>${t}</p>` : '';
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Case file ${esc(input.d.dispute_id)}</title>
<style>body{font:14px/1.5 Inter,system-ui,sans-serif;color:#1d1d1b;background:#fff;max-width:760px;margin:32px auto;padding:0 16px}h1{font-size:22px;margin:0 0 8px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:#6b6a64;margin:22px 0 6px;border-bottom:1px solid #e3e0d8;padding-bottom:4px}p{margin:4px 0}.b{padding-left:14px;text-indent:-10px}.b::before{content:"\\2022  "}em{color:#6b6a64}.bar{margin:0 0 16px}button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid #1f5c4a;background:#1f5c4a;color:#fff;cursor:pointer}@media print{.bar{display:none}body{margin:0}}</style></head>
<body><div class="bar"><button onclick="window.print()">Save as PDF</button></div>
${body}</body></html>`;
}
