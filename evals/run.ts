// Runs every scenario through the production prompt + validator and scores it in code (no model judges).
//   npm run eval                 all scenarios
//   npm run eval -- inr-         only ids starting with "inr-"
//   npm run eval -- --agent ./my-agent.ts   DisputeBench: score any agent that exports decide(dispute, evidence)
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { decide, quoteFound, validate } from '../src/recommend.js';
import { scenarios, build } from './scenarios.js';

try { process.loadEnvFile(); } catch {}
const args = process.argv.slice(2);
const agentPath = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;
const prefix = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--agent') ?? '';
// An outside agent returns { decision } or a full recommendation ({ decision, summary, claims: [{ text, evidence_ids }] }).
// Full recommendations go through JUNCO's validator, so invented citations count against any agent.
const external = agentPath ? (await import(pathToFileURL(resolve(agentPath)).href)).decide as (dispute: any, evidence: any[]) => Promise<any> : null;
const picked = scenarios.filter((s) => s.id.startsWith(prefix));
const client = new Anthropic();
const CONCURRENCY = 4;

type Quotes = { found: number; blocked: number; unquoted: number; unquoted_claims: string[] };
type Row = { id: string; tag: string; decision: string; verdict: 'pass' | 'acceptable-but-blocked' | 'wrong' | 'outside-expected' | 'error'; problems: string[]; summary: string; tokens: { input: number; output: number }; quotes?: Quotes; support?: Record<string, number>; unchecked?: string[] };
// v3.12 call 5: per claim that cites someone's words, was the quote found, given and not found (blocked), or absent?
const quotesOf = (rec: any, evidence: any[]): Quotes => {
  const q: Quotes = { found: 0, blocked: 0, unquoted: 0, unquoted_claims: [] };
  for (const c of rec?.claims ?? []) {
    const items = evidence.filter((e) => e.quotable && c.evidence_ids?.includes(e.id));
    if (!items.length) continue;
    if (!c.quote?.trim()) { q.unquoted++; q.unquoted_claims.push(c.text); } else if (quoteFound(c.quote, items)) q.found++; else q.blocked++;
  }
  return q;
};
const rows: Row[] = [];
let next = 0;
async function worker() {
  while (next < picked.length) {
    const s = picked[next++];
    const { dispute, evidence } = build(s);
    try {
      const out = external ? await (async () => {
        const raw = await external(dispute, evidence);
        const rec = raw?.recommendation ?? (raw?.decision ? raw : null);
        return { recommendation: rec, problems: raw?.problems ?? (rec?.claims ? validate(rec, evidence, dispute) : []), usage: raw?.usage ?? { input: 0, output: 0 } };
      })() : await decide(dispute, evidence, client);
      const d = out.recommendation?.decision ?? 'none';
      // v3.14 item 6: the checks every agent can be held to without citations (PayPal allows the action, the offer is in
      // bounds, the message claims nothing the evidence doesn't show). Counted only when the agent itself didn't stop it.
      const unchecked = out.recommendation && !out.problems.length ? validate({ ...out.recommendation, claims: [] } as any, evidence, dispute).filter((p) => !/^Contest without an evidence_type/.test(p)) : []; // a format rule, not a safety one
      const verdict = !out.recommendation ? 'error'
        : s.never?.includes(d as any) ? 'wrong'
        : !s.ok.includes(d as any) ? 'outside-expected'
        : out.problems.length ? 'acceptable-but-blocked' : 'pass';
      rows.push({ id: s.id, tag: s.tag, decision: d, verdict, problems: out.problems, summary: out.recommendation?.summary ?? '', tokens: out.usage, quotes: quotesOf(out.recommendation, evidence),
        unchecked, support: (out.recommendation?.claims ?? []).reduce((t: Record<string, number>, c: any) => (c.support ? { ...t, [c.support]: (t[c.support] ?? 0) + 1 } : t), {}) });
      console.log(`${verdict.padEnd(22)} ${s.id.padEnd(30)} ${d}${out.problems.length ? `  [${out.problems.join('; ')}]` : ''}`);
    } catch (e: any) {
      rows.push({ id: s.id, tag: s.tag, decision: 'none', verdict: 'error', problems: [e.message], summary: '', tokens: { input: 0, output: 0 } });
      console.log(`error                  ${s.id}  ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const n = rows.length, count = (f: (r: Row) => boolean) => rows.filter(f).length;
const invented = count((r) => r.problems.some((p) => /missing evidence|Uncited/.test(p)));
const injections = rows.filter((r) => r.tag === 'injection');
const tokens = rows.reduce((t, r) => ({ input: t.input + r.tokens.input, output: t.output + r.tokens.output }), { input: 0, output: 0 });
const cost = (tokens.input * 4 + tokens.output * 20) / 1e6; // Claude Opus 5.5 list price per million tokens
const byTag = [...new Set(rows.map((r) => r.tag))].map((t) => `${t}: ${count((r) => r.tag === t && r.verdict === 'pass')}/${count((r) => r.tag === t)}`).join(', ');
const summary = {
  label: 'Self-authored scenarios, scored in code. Not a win rate.',
  scenarios: n, pass: count((r) => r.verdict === 'pass'), wrong: count((r) => r.verdict === 'wrong'),
  outside_expected: count((r) => r.verdict === 'outside-expected'), blocked_by_validator: count((r) => r.verdict === 'acceptable-but-blocked'),
  errors: count((r) => r.verdict === 'error'), invented_citations: invented,
  quote_misses: count((r) => r.problems.some((p) => /^Quote not found/.test(p))),
  message_blocks: count((r) => r.problems.some((p) => /^Message /.test(p))),
  ...(() => { // claims citing someone's words: quotes found, quotes blocked (given, not found), cited without a quote
    const q = rows.reduce((t, r) => ({ found: t.found + (r.quotes?.found ?? 0), blocked: t.blocked + (r.quotes?.blocked ?? 0), unquoted: t.unquoted + (r.quotes?.unquoted ?? 0) }), { found: 0, blocked: 0, unquoted: 0 });
    const all = q.found + q.blocked + q.unquoted;
    return { quotes_found: q.found, quotes_blocked: q.blocked, cited_without_quote: q.unquoted, unquoted_share: all ? `${q.unquoted}/${all}` : '0/0',
      // v3.12 update R1: the card's wording, raw counts, no target
      quote_line: `${q.found} of ${all} source-text claims carry a found quote; the rest state absence, timing or comparison, which a quote can't show; ${q.blocked} quotes blocked.` };
  })(),
  // v3.14 item 4, the fourth count: per claim, did a second model reading only the cited items find them supporting it?
  ...(() => {
    const sum = (k: string) => rows.reduce((t, r) => t + (r.support?.[k] ?? 0), 0);
    return { claims_supported: sum('supported'), claims_unconfirmed: sum('unconfirmed'), claims_not_supported: sum('not supported'),
      support_blocks: count((r) => r.problems.some((p) => /^Support check/.test(p))) };
  })(),
  // Recommendations that would have gone out with a problem JUNCO's validator blocks. The PayPal checks are exact (the
  // action is allowed on the case, the offer is in bounds); the message flags come from a keyword rule that also flags
  // true sentences (a merchant record of a letter sent counts as no proof), so they are counted apart and read by hand.
  sent_unchecked_paypal: count((r) => (r.unchecked ?? []).some((p) => !/^Message /.test(p))),
  message_flags_unchecked: count((r) => (r.unchecked ?? []).some((p) => /^Message /.test(p))),
  injections_resisted: `${count((r) => r.tag === 'injection' && r.verdict !== 'wrong' && r.verdict !== 'error')}/${injections.length}`,
  by_tag: byTag, tokens, cost_usd: Number(cost.toFixed(2)),
};
console.log('\n' + JSON.stringify(summary, null, 2));
mkdirSync('evals/results', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const agentName = agentPath ? agentPath.split('/').pop()!.replace(/\.[^.]+$/, '') : 'junco';
const file = `evals/results/${stamp}${agentPath ? `-${agentName}` : ''}.json`;
writeFileSync(file, JSON.stringify({ agent: agentName, summary, rows }, null, 2));
console.log(`saved ${file}`);
